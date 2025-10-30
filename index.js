// index.js
// Super-simple version: CORS first, order lookup, tracking

const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

// ENV you MUST set in Heroku:
// SHOP=ledspace-lighting.myshopify.com   (NO https://, NO trailing /)
// ADMIN_TOKEN=shpat_....                 (Admin API token with read_orders, read_products, read_fulfillments)
// ALLOWED_ORIGIN=https://www.ledspace.co.uk,https://ledspace.co.uk,https://ledspace-lighting.myshopify.com
// ADMIN_VERSION=2024-10   (optional, defaults below)

const SHOP = process.env.SHOP;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const ADMIN_VERSION = process.env.ADMIN_VERSION || '2024-10';

// if you forget ALLOWED_ORIGIN, we fall back to these:
const FALLBACK_ORIGINS = [
  'https://www.ledspace.co.uk',
  'https://ledspace.co.uk',
  'https://ledspace-lighting.myshopify.com',
];

const ALLOWED_ORIGIN_ENV = process.env.ALLOWED_ORIGIN || '';
const ALLOWED_ORIGINS = ALLOWED_ORIGIN_ENV
  ? ALLOWED_ORIGIN_ENV.split(',').map((s) => s.trim()).filter(Boolean)
  : FALLBACK_ORIGINS;

// 1) BASIC MIDDLEWARE
app.use(express.json());

// 2) CORS — ALWAYS run this
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // log so we can see what the browser actually sends
  console.log('Incoming Origin:', origin);

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  next();
});

// small helper
function normalisePostcode(pc) {
  return String(pc || '').toUpperCase().replace(/\s+/g, '').trim();
}

// very small fetch wrapper to Shopify Admin
async function shopifyAdminFetch(path, opts = {}) {
  if (!SHOP || !ADMIN_TOKEN) {
    throw new Error('SHOP or ADMIN_TOKEN not configured');
  }

  const url = `https://${SHOP}/admin/api/${ADMIN_VERSION}${path}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'X-Shopify-Access-Token': ADMIN_TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error('Shopify Admin error', res.status, json);
    const msg = json && json.errors ? JSON.stringify(json.errors) : res.statusText;
    const err = new Error('Shopify Admin error: ' + msg);
    err.status = res.status;
    throw err;
  }

  return json;
}

// health route
app.get('/', (req, res) => {
  res.send('Help Hub Order API is up');
});

// debug route so you can check CORS
app.get('/debug/origins', (req, res) => {
  res.json({
    ok: true,
    allowed: ALLOWED_ORIGINS,
    shop: SHOP,
    version: ADMIN_VERSION,
  });
});

// MAIN: POST /order-lookup
app.post('/order-lookup', async (req, res) => {
  try {
    const { orderCode, postcode } = req.body || {};
    if (!orderCode || !postcode) {
      return res.status(400).json({ ok: false, error: 'Missing orderCode or postcode' });
    }

    const targetPc = normalisePostcode(postcode);

    // 1) get order(s) by name
    const list = await shopifyAdminFetch(
      `/orders.json?status=any&name=${encodeURIComponent(orderCode)}`
    );
    const orders = Array.isArray(list.orders) ? list.orders : [];

    if (!orders.length) {
      return res.status(404).json({ ok: false, error: 'Order not found' });
    }

    // 2) match postcode
    let order = null;
    for (const o of orders) {
      const shipPc = o.shipping_address ? normalisePostcode(o.shipping_address.zip) : '';
      const billPc = o.billing_address ? normalisePostcode(o.billing_address.zip) : '';
      if (shipPc && shipPc === targetPc) {
        order = o;
        break;
      }
      if (billPc && billPc === targetPc) {
        order = o;
        break;
      }
    }
    if (!order) {
      order = orders[0];
    }

    // 3) build tracking
    const tracking = [];
    if (Array.isArray(order.fulfillments)) {
      for (const f of order.fulfillments) {
        const company = f.tracking_company || f.shipping_company || null;
        const numbers = Array.isArray(f.tracking_numbers) && f.tracking_numbers.length
          ? f.tracking_numbers
          : (f.tracking_number ? [f.tracking_number] : []);
        const urls = Array.isArray(f.tracking_urls) && f.tracking_urls.length
          ? f.tracking_urls
          : (f.tracking_url ? [f.tracking_url] : []);

        if (numbers.length) {
          numbers.forEach((num, idx) => {
            tracking.push({
              number: num,
              url: urls[idx] || urls[0] || null,
              company,
            });
          });
        } else if (urls.length) {
          tracking.push({
            number: null,
            url: urls[0],
            company,
          });
        }
      }
    }

    // 4) get products for line items
    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    const productIds = [...new Set(lineItems.map(li => li.product_id).filter(Boolean))];

    const productsById = {};
    for (const pid of productIds) {
      try {
        const pj = await shopifyAdminFetch(`/products/${pid}.json`);
        if (pj && pj.product) {
          productsById[pid] = pj.product;
        }
      } catch (e) {
        console.warn('Could not fetch product', pid, e.message);
      }
    }

    const items = lineItems.map(li => {
      const p = li.product_id ? productsById[li.product_id] : null;
      return {
        title: p ? p.title : li.title,
        handle: p ? p.handle : null,
        image: (p && Array.isArray(p.images) && p.images.length) ? p.images[0].src : null,
        skus: li.sku ? [li.sku] : [],
      };
    });

    return res.json({
      ok: true,
      order: {
        id: order.id,
        name: order.name,
        orderNumber: order.order_number,
        tracking,
      },
      items,
    });
  } catch (err) {
    console.error('Order lookup error:', err.message);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log('Help Hub Order API listening on port', PORT);
  console.log('SHOP:', SHOP);
  console.log('ALLOWED_ORIGINS:', ALLOWED_ORIGINS);
});
