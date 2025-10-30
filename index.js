import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// ─── ENV from Heroku ─────────────────────────────────────────────
const SHOP = process.env.SHOP; // e.g. "ledspace-lighting.myshopify.com"
const ADMIN_TOKEN = process.env.ADMIN_TOKEN; // shpat_...
const ADMIN_VERSION = process.env.ADMIN_VERSION || "2024-10";
// ALLOWED_ORIGIN can be comma-separated, e.g.
// "https://www.ledspace.co.uk,https://ledspace-lighting.myshopify.com"
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
// ─────────────────────────────────────────────────────────────────

// turn "a,b,c " → ["a","b","c"]
const allowedOrigins = ALLOWED_ORIGIN
  ? ALLOWED_ORIGIN.split(",").map((o) => o.trim().replace(/\/$/, ""))
  : [];

// log what we’ve actually got, so we can see it in Heroku logs
console.log("Help Hub API starting…");
console.log("SHOP:", SHOP);
console.log("ADMIN_VERSION:", ADMIN_VERSION);
console.log("Allowed origins:", allowedOrigins);

app.use(express.json());

// CORS: allow any of the comma-separated origins, + non-browser requests
app.use(
  cors({
    origin: function (origin, cb) {
      // If ALLOWED_ORIGIN not set at all → allow everything (handy for tests)
      if (!ALLOWED_ORIGIN) {
        console.log("CORS: no ALLOWED_ORIGIN set → allow all");
        return cb(null, true);
      }

      // curl / Postman / server-to-server often have no Origin
      if (!origin) {
        console.log("CORS: no origin → allow");
        return cb(null, true);
      }

      const cleanOrigin = origin.replace(/\/$/, "");
      if (allowedOrigins.includes(cleanOrigin)) {
        console.log("CORS: allowed:", cleanOrigin);
        return cb(null, true);
      }

      console.log("CORS: BLOCKED:", origin, "not in", allowedOrigins);
      return cb(new Error("Not allowed by CORS: " + origin), false);
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

    // 👇 UPDATED: removed orderNumber from the query to avoid
    // "Field 'orderNumber' doesn't exist on type 'Order'"
    const gql = `
      query FindOrder($q: String!) {
        orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              name
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
      }
    `;

    const data = await shopifyAdminFetch({
      shop: SHOP,
      token: ADMIN_TOKEN,
      version: ADMIN_VERSION,
      query: gql,
      variables: { q: query },
    });

    const orders = data?.orders?.edges?.map((e) => e.node) || [];

    // match on postcode (shipping or billing), normalised
    const match = orders.find((o) => {
      const ship = normalisePostcode(o?.shippingAddress?.zip);
      const bill = normalisePostcode(o?.billingAddress?.zip);
      return ship === pc || bill === pc;
    });

    if (!match) {
      return res
        .status(404)
        .json({ ok: false, error: "Order not found for that postcode." });
    }

    // dedupe products by handle
    const byHandle = new Map();
    for (const edge of match.lineItems?.edges || []) {
      const li = edge.node || {};
      const v = li.variant || {};
      const p = v.product || {};
      if (!p?.handle) continue;

      if (!byHandle.has(p.handle)) {
        byHandle.set(p.handle, {
          title: p.title || li.title || p.handle,
          handle: p.handle,
          image: p.featuredImage?.url || "",
          skus: [],
        });
      }

      if (v.sku) {
        const item = byHandle.get(p.handle);
        if (!item.skus.includes(v.sku)) item.skus.push(v.sku);
      }
    }

    const items = Array.from(byHandle.values());
    if (!items.length) {
      return res
        .status(404)
        .json({ ok: false, error: "No products found on that order." });
    }

    // we removed orderNumber from the query, so return a safe shape
    return res.json({
      ok: true,
      order: {
        name: match.name,
        // try to derive a numeric-ish id from the name, otherwise null
        orderNumber: deriveOrderNumberFromName(match.name),
      },
      items,
    });
  } catch (err) {
    console.error("order-lookup error:", err?.message || err);
    // send the REAL message back to the browser so we can see it
    return res.status(500).json({
      ok: false,
      error: err?.message || "Server error",
    });
  }
});

app.listen(PORT, () => {
  console.log("Help Hub Order API listening on port " + PORT);
});

// ─── helpers ─────────────────────────────────────────────────────
function normalisePostcode(s) {
  return String(s || "").toUpperCase().replace(/\s+/g, "").trim();
}

function buildOrderSearchQuery(orderCode) {
  const code = String(orderCode).trim();
  const hashCode = code.startsWith("#") ? code : `#${code}`;
  const maybeNum = code.replace(/[^0-9]/g, "");
  const parts = [
    `name:"${escapeQuotes(code)}"`,
    `name:"${escapeQuotes(hashCode)}"`,
  ];
  if (maybeNum) {
    parts.push(`order_number:${maybeNum}`);
  }
  return parts.join(" OR ");
}

function escapeQuotes(s) {
  return s.replace(/"/g, '\\"');
}

// if your order name is something like "LS74193" we can still
// expose a numeric-like field for the UI, but it's optional
function deriveOrderNumberFromName(name) {
  if (!name) return null;
  // strip leading '#'
  const clean = name.replace(/^#/, "");
  // if it has digits, return just digits
  const digits = clean.replace(/[^0-9]/g, "");
  return digits || clean;
}

async function shopifyAdminFetch({ shop, token, version, query, variables }) {
  const url = `https://${shop}/admin/api/${version}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("Shopify Admin HTTP error", res.status, txt);
    // include the text so we can see if it's "missing scope" / "invalid token" / etc.
    throw new Error(`Shopify HTTP ${res.status}: ${txt}`);
  }

  const json = await res.json();
  if (json.errors) {
    console.error("Shopify Admin GraphQL error", json.errors);
    const first = json.errors[0];
    throw new Error(first?.message || "Shopify GraphQL error");
  }

  return json.data;
}
