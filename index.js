// index.js
// Help Hub Order API — orders + products + tracking
//
// ENV NEEDED:
//   SHOP=ledspace-lighting.myshopify.com   (or your actual shop domain, no https://)
//   ADMIN_TOKEN=shpat_...                  (Admin API token with read_orders, read_products, read_fulfillments)
//   ADMIN_VERSION=2024-10                  (optional)
//   ALLOWED_ORIGIN=https://www.ledspace.co.uk,https://ledspace.co.uk,https://ledspace-lighting.myshopify.com

const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const SHOP = process.env.SHOP;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const ADMIN_VERSION = process.env.ADMIN_VERSION || '2024-10';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

const DEFAULT_ALLOWED = [
  'https://www.ledspace.co.uk',
  'https://ledspace.co.uk',
  'https://ledspace-lighting.myshopify.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const ALLOWED_ORIGINS = [
  ...new Set(
    ALLOWED_ORIGIN
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .concat(DEFAULT_ALLOWED)
  ),
];

app.use(express.json());

// CORS middleware — always run this first
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // log origin so we can see what the browser is actually sending
  if (origin) {
    console.log('Incoming Origin:', origin);
  }

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') {
    // preflight OK
    return res.status(200).end();
  }

  next();
});

function normalisePostcode(pc) {
  return String(pc || '').toUpperCase().replace(/\s+/g, '').trim();
}

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
      Accept: 'application/json',
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

// health
app.get('/', (req, res) => {
  res.send('Help Hub Order API');
});

// small debug route so you can see allowed origins in browser
app.get('/debug/origins', (req, res) => {
  res.json({
    ok: true,
    allowed: ALLOWED_ORIGINS,
    shop: SHOP,
    version: ADMIN_VERSION,
  });
});

// main route
app.post('/order-lookup', async (req, res) => {
  try {
    const { orderCode, postcode } = req.body || {};
    if (!orderCode || !postcode) {
      return res.status(400).json({ ok: false, error: 'Missing orderCode or postcode' });
    }

    const targetPostcode = normalisePostcode(postcode);

    // find by name
    const orderList = await shopifyAdminFetch(
      `/orders.json?status=any&name=${encodeURIComponent(orderCode)}`
    );

    const orders = Array.isArray(orderList.orders) ? orderList.orders : [];
    if (!orders.length) {
      return res.status(404).json({ ok: false, error: 'Order not found' });
    }

    // pick order with matching postcode
    let matched = null;
    for (const o of orders) {
      const shipPc = o.shipping_address ? normalisePostcode(o.shipping_address.zip) : '';
      const billPc = o.billing_address ? normalisePostcode(o.billing_address.zip) : '';
      if (shipPc && shipPc === targetPostcode) {
        matched = o;
        break;
      }
      if (billPc && billPc === targetPostcode) {
        matched = o;
        break;
      }
    }
    const order = matched || orders[0];

    // tracking from fulfillments
    const tracking = [];
    if (Array.isArray(order.fulfillments) && order.fulfillments.length) {
      for (const f of order.fulfillments) {
        const numbers =
          Array.isArray(f.tracking_numbers) && f.tracking_numbers.length
            ? f.tracking_numbers
            : f.tracking_number
            ? [f.tracking_number]
            : [];
        const urls =
          Array.isArray(f.tracking_urls) && f.tracking_urls.length
            ? f.tracking_urls
            : f.tracking_url
            ? [f.tracking_url]
            : [];
        const company = f.tracking_company || f.shipping_company || null;

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

    // collect products from line items
    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    const productIds = [...new Set(lineItems.map((li) => li.product_id).filter(Boolean))];

    const productsById = {};
    for (const pid of productIds) {
      try {
        const pjson = await shopifyAdminFetch(`/products/${pid}.json`);
        if (pjson && pjson.product) {
          productsById[pid] = pjson.product;
        }
      } catch (e) {
        console.warn('Failed to load product', pid, e.message);
      }
    }

    const items = lineItems.map((li) => {
      const p = li.product_id ? productsById[li.product_id] : null;
      const handle = p ? p.handle : null;
      const image =
        p && Array.isArray(p.images) && p.images.length ? p.images[0].src : null;

      const skus = [];
      if (li.sku) skus.push(li.sku);

      return {
        title: p ? p.title : li.title,
        handle,
        image,
        skus,
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
    console.error('Order lookup error:', err);
    // IMPORTANT: still return JSON so the browser .json() doesn’t crash
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log('Help Hub API starting…');
  console.log('SHOP:', SHOP);
  console.log('ADMIN_VERSION:', ADMIN_VERSION);
  console.log('Allowed origins:', ALLOWED_ORIGINS);
  console.log(`Help Hub Order API listening on port ${PORT}`);
});
