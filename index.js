import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG (set in Heroku later) ─────────────────────────────
const SHOP = process.env.SHOP;               // e.g. "your-shop.myshopify.com"
const ADMIN_TOKEN = process.env.ADMIN_TOKEN; // Admin API access token
const ADMIN_VERSION = process.env.ADMIN_VERSION || "2024-10";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ""; // e.g. "https://yourshop.com"
// ─────────────────────────────────────────────────────────────

app.use(express.json());
app.use(
  cors({
    origin: function (origin, cb) {
      // allow same-origin / curl / Postman with no Origin
      if (!ALLOWED_ORIGIN) return cb(null, true);
      if (!origin) return cb(null, true);
      if (origin === ALLOWED_ORIGIN) return cb(null, true);
      return cb(new Error("Not allowed by CORS"), false);
    },
  })
);

// health check
app.get("/", (req, res) => {
  res.json({ ok: true, msg: "Help Hub Order API is running" });
});

// main endpoint
app.post("/order-lookup", async (req, res) => {
  try {
    const { orderCode, postcode } = req.body || {};
    const code = (orderCode || "").trim();
    const pc = normalisePostcode(postcode || "");

    if (!code || !pc) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing orderCode or postcode" });
    }

    if (!SHOP || !ADMIN_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: "Server not configured (SHOP / ADMIN_TOKEN missing)",
      });
    }

    const query = buildOrderSearchQuery(code);
    const gql = `
      query FindOrder($q: String!) {
        orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              name
              orderNumber
              shippingAddress { zip }
              billingAddress  { zip }
              lineItems(first: 100) {
                edges {
                  node {
                    title
                    quantity
                    variant {
                      sku
                      product {
                        handle
                        title
                        featuredImage { url }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`;

    const data = await shopifyAdminFetch({
      shop: SHOP,
      token: ADMIN_TOKEN,
      version: ADMIN_VERSION,
      query: gql,
      variables: { q: query },
    });

    const orders = data?.orders?.edges?.map((e) => e.node) || [];
    const match = orders.find((o) => {
      const z1 = normalisePostcode(o?.shippingAddress?.zip);
      const z2 = normalisePostcode(o?.billingAddress?.zip);
      return z1 === pc || z2 === pc;
    });

    if (!match) {
      return res
        .status(404)
        .json({ ok: false, error: "Order not found for that postcode." });
    }

    // build product list
    const productMap = new Map();
    for (const edge of match.lineItems?.edges || []) {
      const li = edge.node || {};
      const v = li.variant || {};
      const p = v.product || {};
      if (!p?.handle) continue;
      if (!productMap.has(p.handle)) {
        productMap.set(p.handle, {
          title: p.title || li.title || p.handle,
          handle: p.handle,
          image: p.featuredImage?.url || "",
          skus: [],
        });
      }
      if (v.sku) {
        const item = productMap.get(p.handle);
        if (!item.skus.includes(v.sku)) item.skus.push(v.sku);
      }
    }

    const items = Array.from(productMap.values());
    if (!items.length) {
      return res
        .status(404)
        .json({ ok: false, error: "No products found on that order." });
    }

    return res.json({
      ok: true,
      order: {
        name: match.name,
        orderNumber: match.orderNumber,
      },
      items,
    });
  } catch (err) {
    console.error("order-lookup error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Help Hub Order API listening on port ${PORT}`);
});

// ─── Helpers ──────────────────────────────────────────────────────────────
function normalisePostcode(s) {
  return String(s || "").toUpperCase().replace(/\s+/g, "").trim();
}

function buildOrderSearchQuery(orderCode) {
  const code = String(orderCode).trim();
  const hashCode = code.startsWith("#") ? code : `#${code}`;
  const maybeNum = code.replace(/[^0-9]/g, "");
  const parts = [`name:"${escapeQuotes(code)}"`, `name:"${escapeQuotes(hashCode)}"`];
  if (maybeNum) {
    parts.push(`order_number:${maybeNum}`);
  }
  return parts.join(" OR ");
}

function escapeQuotes(s) {
  return s.replace(/"/g, '\\"');
}

async function shopifyAdminFetch({ shop, token, version, query, variables }) {
  const url = `https://${shop}/admin/api/${version}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Shopify admin HTTP error:", res.status, text);
    throw new Error("Shopify Admin API HTTP error");
  }

  const json = await res.json();
  if (json.errors) {
    console.error("Shopify admin GraphQL error:", json.errors);
    throw new Error("Shopify Admin API GraphQL error");
  }

  return json.data;
}
