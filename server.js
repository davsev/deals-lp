const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const apiKey = process.env.CHING_API_KEY || process.env.CHING_API_KEY_TEST;
const apiBase = 'https://api.ching.co.il/ching/v1';

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

function getOrigin(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || 'http';
  return `${proto}://${req.headers.host}`;
}

function toAgorot(value) {
  return Math.round(Number(value) * 100);
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
      success_url: `${origin}/checkout-success.html?cs={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout.html`,
      create_document: true
    });

    sendJson(res, 200, { url: session.url, id: session.id });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || 'Failed to create checkout session' });
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
