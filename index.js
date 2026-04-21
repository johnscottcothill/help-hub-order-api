// index.js
// Help Hub Order API — Express + Axios (safe for Heroku)

const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ENV you MUST set on Heroku:
//
// SHOP=ledspace-lighting.myshopify.com      // no https://, no trailing /
// ADMIN_TOKEN=shpat_...                     // Admin token with read_orders, read_products, read_fulfillments
// ALLOWED_ORIGIN=https://www.ledspace.co.uk,https://ledspace.co.uk,https://ledspace-lighting.myshopify.com
// ADMIN_VERSION=2024-10                     // optional

const SHOP = process.env.SHOP;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const ADMIN_VERSION = process.env.ADMIN_VERSION || '2024-10';

const FALLBACK_ORIGINS = [
  'https://www.ledspace.co.uk',
  'https://ledspace.co.uk',
  'https://ledspace-lighting.myshopify.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

const ALLOWED_ORIGIN_ENV = process.env.ALLOWED_ORIGIN || '';
const ALLOWED_ORIGINS = ALLOWED_ORIGIN_ENV
  ? ALLOWED_ORIGIN_ENV.split(',').map(s => s.trim()).filter(Boolean)
  : FALLBACK_ORIGINS;

app.use(express.json());

// CORS — run before everything else
app.use((req, res, next) => {
  const origin = req.headers.origin;
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

function normalisePostcode(pc) {
  return String(pc || '').toUpperCase().replace(/\s+/g, '').trim();
}

// Simple Shopify Admin call using Axios
async function shopifyAdminGet(path) {
  if (!SHOP || !ADMIN_TOKEN) {
    throw new Error('SHOP or ADMIN_TOKEN not configured');
  }
  const url = `https://${SHOP}/admin/api/${ADMIN_VERSION}${path}`;
  const resp = await axios.get(url, {
    headers: {
      'X-Shopify-Access-Token': ADMIN_TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });
  return resp.data;
}

// PUT version of the above
async function shopifyAdminPut(path, payload) {
  if (!SHOP || !ADMIN_TOKEN) {
    throw new Error('SHOP or ADMIN_TOKEN not configured');
  }
  const url = `https://${SHOP}/admin/api/${ADMIN_VERSION}${path}`;
  const resp = await axios.put(url, payload, {
    headers: {
      'X-Shopify-Access-Token': ADMIN_TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });
  return resp.data;
}

// fn to get existing tags, add new tags. 
// must do this to append as PUT will just overwrite
async function addOrderTags(orderId, newTags) {
  const order = await shopifyAdminGet(`/orders/${orderId}.json`);
  const existingTags = order.order.tags
    ? order.order.tags.split(',').map(t => t.trim())
    : [];

  const merged = [...new Set([...existingTags, ...newTags])];

  return shopifyAdminPut(`/orders/${orderId}.json`, {
    order: {
      id: orderId,
      tags: merged.join(', ')
    }
  });
}

// health
app.get('/', (req, res) => {
  res.send('Help Hub Order API is up');
});

// debug — so you can test CORS from the browser
app.get('/debug/origins', (req, res) => {
  res.json({
    ok: true,
    allowed: ALLOWED_ORIGINS,
    shop: SHOP,
    version: ADMIN_VERSION
  });
});

// main: POST /order-lookup
app.post('/order-lookup', async (req, res) => {
  try {
    const { orderCode, postcode } = req.body || {};
    if (!orderCode || !postcode) {
      return res.status(400).json({ ok: false, error: 'Missing orderCode or postcode' });
    }

    const targetPc = normalisePostcode(postcode);

    // 1) find order(s) by name
    const list = await shopifyAdminGet(`/orders.json?status=any&name=${encodeURIComponent(orderCode)}`);
    const orders = Array.isArray(list.orders) ? list.orders : [];

    if (!orders.length) {
      return res.status(404).json({ ok: false, error: 'Order not found' });
    }

    // 2) pick the one matching postcode (shipping or billing)
    let order = null;
    for (const o of orders) {
      const shipPc = o.shipping_address ? normalisePostcode(o.shipping_address.zip) : '';
      const billPc = o.billing_address ? normalisePostcode(o.billing_address.zip) : '';
        if (shipPc && shipPc === targetPc) {
            order = o;
            break;
        }
        else if (billPc && billPc === targetPc) {
            order = o;
            break;
        }
        else {
            return res.status(400).json({ ok: false, error: 'No match found' });
        }
    }
    if (!order) {
      order = orders[0];
    }

    // 3) tracking from fulfillments
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
              company
            });
          });
        } else if (urls.length) {
          tracking.push({
            number: null,
            url: urls[0],
            company
          });
        }
      }
    }

    // 4) gather products for line items
    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    const productIds = [...new Set(lineItems.map(li => li.product_id).filter(Boolean))];

    const productsById = {};

    for (const pid of productIds) {
      try {
        const pdata = await shopifyAdminGet(`/products/${pid}.json`);
        if (pdata && pdata.product) {
          productsById[pid] = pdata.product;
        }
      } catch (e) {
        console.warn('Could not load product', pid, e.message);
      }
    }

    const items = lineItems.map(li => {
      const p = li.product_id ? productsById[li.product_id] : null;
      return {
        title: p ? p.title : li.title,
        handle: p ? p.handle : null,
        image: (p && Array.isArray(p.images) && p.images.length) ? p.images[0].src : null,
        skus: li.sku ? [li.sku] : [],
		image_alt: (p && Array.isArray(p.images) && p.images.length) ? p.images[0].alt : 'alt text not found',
		p_id: li.product_id,
        qty: li.quantity ? li.quantity : 0 // return 0 if not found
      };
    });

    // add tag to order to log access (post purchase)
    try{ 
        await addOrderTags(order.id, ["HH_Post_Sales"]);
    }
    catch(e){
        console.error("tagging failed: ", e.message);
    }



    return res.json({
      ok: true,
      order: {
        id: order.id,
        name: order.name,
        orderNumber: order.order_number,
        tracking
      },
      items
    });
  } catch (err) {
    console.error('Order lookup error:', err.message);
    // still return JSON so browser .json() works
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});


// Shopify admin supports partial SKU searches, so moved the 'sku-lookup' here
app.post("/sku-search", async (req, res) => {
  const { q } = req.body || {};

  if (!q || q.length < 2) {
    return res.json([]);
  }

  try {
    // query
    const queryString = `sku:${q}* OR sku:${q.toUpperCase()}*`;

    const gql = `
      query SkuLookup($query: String!) {
        productVariants(first: 20, query: $query) {
          edges {
            node {
              sku
              image { url }
              product {
                handle
                title
                featuredImage { url }
              }
            }
          }
        }
      }
    `;
    
    const endpoint = `https://${SHOP}/admin/api/${ADMIN_VERSION}/graphql.json`;

    const response = await axios.post(
        endpoint, 
        {
        query: gql,
        variables: {query: queryString},
        },
        {
            headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": ADMIN_TOKEN
            }
    });



    const result = await response.data;
    console.log("feedback ", JSON.stringify(result));

    if (result.errors) {
      console.error("Shopify error:", result.errors);
      return res.status(500).json([]);
    }

    const edges = result?.data?.productVariants?.edges || [];

    const results = [];
    const seen = new Set();

    for (const e of edges) {
      const v = e.node;
      if (!v) continue;

      const product = v.product || {};
      const handle = product.handle;

      if (!handle || seen.has(handle)) continue;

      seen.add(handle);

      results.push({
        title: product.title || v.sku || "Product",
        url: `/products/${handle}`,
        image: product.featuredImage?.url || v.image?.url || "",
        sku: v.sku,
        handle: handle
      });
    }

    return res.json(results);

  } catch (err) {
    console.error(`SKU search error:`, err);
    return res.status(500).json([]);
  }
});


app.listen(PORT, () => {
  console.log('Help Hub Order API listening on port', PORT);
  console.log('SHOP:', SHOP);
  console.log('ALLOWED_ORIGINS:', ALLOWED_ORIGINS);
});
