const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const isRailway = Object.keys(process.env).some(key => key.startsWith('RAILWAY_'));
const host = process.env.HOST || (isRailway ? '0.0.0.0' : '127.0.0.1');
const apiKey = process.env.CHING_API_KEY || process.env.CHING_API_KEY_TEST;
const webhookSecret = process.env.CHING_WEBHOOK_SECRET;
const resendApiKey = process.env.RESEND_API_KEY;
const mailFrom = process.env.ORDER_EMAIL_FROM || 'Al Deals <support@al-deals.com>';
const merchantEmail = process.env.ORDER_NOTIFY_EMAIL || 'support@al-deals.com';
const apiBase = 'https://api.ching.co.il/ching/v1';
const pendingOrders = new Map();
const processedEvents = new Set();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4'
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function readText(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function getOrigin(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || 'http';
  return `${proto}://${req.headers.host}`;
}

function toAgorot(value) {
  return Math.round(Number(value) * 100);
}

function formatPrice(value) {
  return '₪' + Number(value).toLocaleString('he-IL', {
    minimumFractionDigits: value % 1 ? 2 : 0,
    maximumFractionDigits: 2
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function validateCart(cart) {
  if (!cart || !Array.isArray(cart.items) || !cart.items.length) {
    throw new Error('הסל ריק.');
  }
  const items = cart.items.map(item => {
    const quantity = Number(item.qty);
    const amount = toAgorot(item.price);
    if (!item.name || !item.variant || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000 || amount < 0) {
      throw new Error('נתוני הסל אינם תקינים.');
    }
    return {
      name: `${item.name} - ${item.variant}`.slice(0, 255),
      description: `כמות: ${quantity}`.slice(0, 500),
      amount_agorot: amount,
      quantity
    };
  });

  const discount = toAgorot(cart.discount || 0);
  if (discount > 0) {
    items.push({
      name: `הנחת כמות ${Math.round(Number(cart.discountRate || 0) * 100)}%`,
      amount_agorot: -discount,
      quantity: 1
    });
  }

  const total = items.reduce((sum, item) => sum + item.amount_agorot * item.quantity, 0);
  if (total < 0) {
    throw new Error('סכום ההזמנה אינו תקין.');
  }
  return items;
}

async function ching(pathname, body) {
  if (!apiKey) {
    const error = new Error('CHING_API_KEY או CHING_API_KEY_TEST חסר. צריך להגדיר מפתח API בצד השרת.');
    error.status = 500;
    throw error;
  }
  const response = await fetch(`${apiBase}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const message = payload.error?.message || payload.message || `Ching API error ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload.data || payload;
}

function verifyChingSignature(rawBody, signature) {
  if (!webhookSecret || !signature) return false;
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function buildOrderEmail(order, event) {
  const rows = order.cart.items.map(item => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #e6edf5">${escapeHtml(item.name)} - ${escapeHtml(item.variant)}</td>
      <td style="padding:10px;border-bottom:1px solid #e6edf5;text-align:center">${item.qty}</td>
      <td style="padding:10px;border-bottom:1px solid #e6edf5;text-align:left">${formatPrice(item.price * item.qty)}</td>
    </tr>
  `).join('');
  const discountRow = order.cart.discount ? `
    <tr>
      <td colspan="2" style="padding:10px;color:#16813b">הנחת כמות</td>
      <td style="padding:10px;text-align:left;color:#16813b">-${formatPrice(order.cart.discount)}</td>
    </tr>
  ` : '';
  return `
    <div dir="rtl" style="font-family:Arial,sans-serif;color:#061c49;line-height:1.6">
      <h1 style="margin:0 0 12px">תודה על ההזמנה!</h1>
      <p>קיבלנו את ההזמנה שלך והיא עברה לתהליך טיפול ומשלוח.</p>
      <h2 style="margin-top:24px">פרטי ההזמנה</h2>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e6edf5">
        <thead>
          <tr style="background:#f4f8fc">
            <th style="padding:10px;text-align:right">מוצר</th>
            <th style="padding:10px;text-align:center">כמות</th>
            <th style="padding:10px;text-align:left">מחיר</th>
          </tr>
        </thead>
        <tbody>${rows}${discountRow}</tbody>
      </table>
      <p style="font-size:20px;font-weight:bold">סה״כ לתשלום: ${formatPrice(order.cart.total || event.data?.amount / 100 || 0)}</p>
      <h2 style="margin-top:24px">פרטי משלוח</h2>
      <p>
        ${escapeHtml(order.customer.firstName)} ${escapeHtml(order.customer.lastName)}<br>
        ${escapeHtml(order.customer.phone)}<br>
        ${escapeHtml(order.customer.address)}, ${escapeHtml(order.customer.city)}${order.customer.zip ? `, ${escapeHtml(order.customer.zip)}` : ''}
      </p>
      ${order.customer.notes ? `<p><strong>הערות:</strong> ${escapeHtml(order.customer.notes)}</p>` : ''}
      <p style="color:#52657e">מספר חיוב Ching: ${escapeHtml(event.data?.id || '')}</p>
    </div>
  `;
}

async function sendEmail({ to, subject, html }) {
  if (!resendApiKey) {
    console.log(`RESEND_API_KEY is not set. Skipping email to ${to}: ${subject}`);
    return;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: mailFrom, to, subject, html })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Resend email failed: ${response.status} ${text}`);
  }
}

async function sendOrderEmails(order, event) {
  const html = buildOrderEmail(order, event);
  await sendEmail({
    to: order.customer.email,
    subject: 'אישור הזמנה - המרכז לרובי מים',
    html
  });
  await sendEmail({
    to: merchantEmail,
    subject: `הזמנה חדשה - ${order.customer.firstName} ${order.customer.lastName}`,
    html
  });
}

async function handleCheckout(req, res) {
  try {
    const { customer, cart } = await readJson(req);
    const fullName = `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim();
    if (!fullName || !customer?.phone || !customer?.email || !customer?.address || !customer?.city) {
      return sendJson(res, 400, { error: 'נא למלא שם, טלפון, אימייל וכתובת מלאה.' });
    }

    const lineItems = validateCart(cart);
    const chingCustomer = await ching('/customers', {
      name: fullName,
      email: customer.email,
      phone: customer.phone
    });

    const origin = getOrigin(req);
    const session = await ching('/checkout_sessions', {
      customer: chingCustomer.id,
      line_items: lineItems,
      success_url: `${origin}/checkout-success.html`,
      cancel_url: `${origin}/checkout.html`,
      create_document: true
    });

    pendingOrders.set(session.id, {
      id: session.id,
      customer,
      cart,
      chingCustomerId: chingCustomer.id,
      createdAt: new Date().toISOString(),
      status: 'pending'
    });

    sendJson(res, 200, { url: session.url, id: session.id });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || 'Failed to create checkout session' });
  }
}

async function handleChingWebhook(req, res) {
  try {
    const rawBody = await readText(req);
    const signature = req.headers['ching-signature'];
    if (!verifyChingSignature(rawBody, Array.isArray(signature) ? signature[0] : signature)) {
      return sendJson(res, 401, { error: 'Invalid Ching signature' });
    }

    const event = JSON.parse(rawBody);
    if (processedEvents.has(event.id)) {
      return sendJson(res, 200, { received: true, duplicate: true });
    }
    processedEvents.add(event.id);

    if (event.type === 'charge.succeeded') {
      const sessionId = event.data?.checkout_session;
      const order = pendingOrders.get(sessionId);
      if (order) {
        order.status = 'paid';
        order.paidAt = new Date().toISOString();
        order.chargeId = event.data?.id;
        await sendOrderEmails(order, event);
      } else {
        console.log(`Paid checkout session not found in memory: ${sessionId || 'missing'}`);
      }
    }

    sendJson(res, 200, { received: true });
  } catch (error) {
    console.error('Ching webhook failed:', error);
    sendJson(res, 500, { error: 'Webhook handling failed' });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.normalize(path.join(root, requested));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/ching/checkout') {
    handleCheckout(req, res);
    return;
  }
  if (req.method === 'POST' && req.url === '/api/ching/webhook') {
    handleChingWebhook(req, res);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }
  serveStatic(req, res);
});

server.listen(port, host, () => {
  console.log(`Water guns landing page running on http://${host}:${port}`);
  if (!apiKey) {
    console.log('CHING_API_KEY or CHING_API_KEY_TEST is not set. Checkout API calls will fail until it is configured.');
  }
});
