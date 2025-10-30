// index.js
// Help Hub Order API — with tracking info
// Expects env:
//   SHOP=ledspace-lighting.myshopify.com   (or your real shop)
//   ADMIN_TOKEN=shpat_...                  (Admin API access token with read_orders, read_products)
//   ADMIN_VERSION=2024-10                  (optional)
//   ALLOWED_ORIGIN=https://www.ledspace.co.uk,https://ledspace.co.uk,...  (comma separated)

const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const SHOP = process.env.SHOP;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const ADMIN_VERSION = process.env.ADMIN_VERSION || '2024-10';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

const ALLOWED_ORIGINS = ALLOWED_ORIGIN
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(express.json());

// CORS – only allow your shop(s)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') {
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
      'Accept': 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json && json.errors ? JSON.stringify(json.errors) : res.statusText;
    const err = new Error('Shopify Admin error: ' + msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

app.get('/', (req, res) => {
  console.log('Health check hit');
  res.send('Help Hub Order API');
});

// POST /order-lookup  { orderCode, postcode }
app.post('/order-lookup', async (req, res) => {
  try {
    const { orderCode, postcode } = req.body || {};
    if (!orderCode || !postcode) {
      return res.status(400).json({ ok: false, error: 'Missing orderCode or postcode' });
    }

    const targetPostcode = normalisePostcode(postcode);

    // We’ll try to find the order by name (that’s what you’re typing: LS74193)
    // This hits the orders endpoint and filters by name.
    // status=any so it also finds fulfilled / archived orders.
    const orderList = await shopifyAdminFetch(
      `/orders.json?status=any&name=${encodeURIComponent(orderCode)}`
    );

    const orders = Array.isArray(orderList.orders) ? orderList.orders : [];

    if (!orders.length) {
      return res.status(404).json({ ok: false, error: 'Order not found' });
    }

    // Find the one whose shipping/billing postcode matches
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

    // Build tracking info from fulfillments
    const tracking = [];
    if (Array.isArray(order.fulfillments) && order.fulfillments.length) {
      for (const f of order.fulfillments) {
        const numbers =
          (Array.isArray(f.tracking_numbers) && f.tracking_numbers.length)
            ? f.tracking_numbers
            : (f.tracking_number ? [f.tracking_number] : []);
        const urls =
          (Array.isArray(f.tracking_urls) && f.tracking_urls.length)
            ? f.tracking_urls
            : (f.tracking_url ? [f.tracking_url] : []);

        const company = f.tracking_company || f.shipping_company || null;

        if (numbers.length) {
          numbers.forEach((num, idx) => {
            tracking.push({
              number: num,
              url: urls[idx] || urls[0] || null,
              company: company,
            });
          });
        } else {
          // no tracking number, but maybe a URL
          if (urls.length) {
            tracking.push({
              number: null,
              url: urls[0],
              company: company,
            });
          }
        }
      }
    }

    // Now gather the products on the order
    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    const productIds = [...new Set(lineItems.map(li => li.product_id).filter(Boolean))];

    const productsById = {};

    // fetch each product to get the handle + image
    for (const pid of productIds) {
      try {
        const pjson = await shopifyAdminFetch(`/products/${pid}.json`);
        if (pjson && pjson.product) {
          productsById[pid] = pjson.product;
        }
      } catch (e) {
        // non-fatal — product might have been deleted
        console.warn('Failed to load product', pid, e.message);
      }
    }

    // Build items we return to the browser
    const items = lineItems.map(li => {
      const p = li.product_id ? productsById[li.product_id] : null;
      const handle = p ? p.handle : null;
      const image =
        p && Array.isArray(p.images) && p.images.length
          ? p.images[0].src
          : null;

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
        name: order.name,               // e.g. LS74193 or #1234
        orderNumber: order.order_number,// numeric
        tracking: tracking,             // array we just built
      },
      items: items,
    });
  } catch (err) {
    console.error('Order lookup error:', err.message);
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
