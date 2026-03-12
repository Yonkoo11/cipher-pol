/**
 * RPC proxy: forwards requests from :5051 to starknet-devnet on :5050
 * and rewrites block_id "pending" -> "latest" everywhere in the JSON body.
 *
 * starknet.js submits transactions with block_id "pending" but devnet 0.7.2
 * doesn't support "pending" on some endpoints. The proxy normalizes this.
 *
 * Usage: node scripts/rpc-proxy.mjs
 */

import http from 'http';

const UPSTREAM = 'http://127.0.0.1:5050';
const PORT = 5051;

function rewritePending(obj) {
  if (typeof obj === 'string') return obj === 'pending' ? 'latest' : obj;
  if (Array.isArray(obj)) return obj.map(rewritePending);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = rewritePending(v);
    }
    // Inject l1_data_gas if a resource_bounds object is missing it.
    // starknet.js 6.24.1 sends l1_gas + l2_gas but not l1_data_gas,
    // which devnet 0.7.2 requires for V3 transactions (Starknet 0.13.2+).
    if (out.resource_bounds && out.resource_bounds.l1_gas && !out.resource_bounds.l1_data_gas) {
      out.resource_bounds.l1_data_gas = { max_amount: '0x0', max_price_per_unit: '0x0' };
    }
    return out;
  }
  return obj;
}

/**
 * Rewrite fee estimate responses for starknet.js 6.24.1 compatibility.
 *
 * devnet 0.7.2 returns RPC 0.10.0 format (l1/l2/l1_data prefixed fields).
 * starknet.js 6.24.1 parseFeeEstimateResponse reads old field names:
 *   gas_consumed, gas_price (unmapped → BigInt(undefined) crash)
 *
 * Mapping: gas_consumed = l2_gas_consumed, gas_price = l2_gas_price
 *          data_gas_consumed = l1_data_gas_consumed, data_gas_price = l1_data_gas_price
 */
function rewriteFeeEstimateResponse(obj) {
  if (Array.isArray(obj)) return obj.map(rewriteFeeEstimateResponse);
  if (obj && typeof obj === 'object') {
    // Recurse into all nested values first
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = rewriteFeeEstimateResponse(v);
    }
    // Then add compatibility aliases for starknet.js 6.24.1
    if (out.l2_gas_consumed !== undefined && out.gas_consumed === undefined) {
      out.gas_consumed = out.l2_gas_consumed;
      out.gas_price = out.l2_gas_price ?? '0x0';
    }
    if (out.l1_data_gas_consumed !== undefined && out.data_gas_consumed === undefined) {
      out.data_gas_consumed = out.l1_data_gas_consumed;
      out.data_gas_price = out.l1_data_gas_price ?? '0x0';
    }
    return out;
  }
  return obj;
}

const server = http.createServer(async (req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    let forwarded = body;
    let isFeeEstimate = false;
    if (body) {
      try {
        const parsed = JSON.parse(body);
        if (parsed.method === 'starknet_estimateFee') isFeeEstimate = true;
        forwarded = JSON.stringify(rewritePending(parsed));
      } catch {}
    }

    const upstreamUrl = new URL(req.url, UPSTREAM);
    const options = {
      hostname: '127.0.0.1',
      port: 5050,
      path: upstreamUrl.pathname + upstreamUrl.search,
      method: req.method,
      headers: {
        ...req.headers,
        host: '127.0.0.1:5050',
        'content-length': Buffer.byteLength(forwarded),
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      if (!isFeeEstimate) {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
        return;
      }
      // Collect response body for fee estimate rewriting
      let respBody = '';
      proxyRes.on('data', chunk => { respBody += chunk; });
      proxyRes.on('end', () => {
        let rewritten = respBody;
        try {
          const parsed = JSON.parse(respBody);
          const patched = rewriteFeeEstimateResponse(parsed);
          rewritten = JSON.stringify(patched);
        } catch {}
        const headers = { ...proxyRes.headers, 'content-length': Buffer.byteLength(rewritten) };
        res.writeHead(proxyRes.statusCode, headers);
        res.end(rewritten);
      });
    });

    proxyReq.on('error', (err) => {
      res.writeHead(502);
      res.end(`Proxy error: ${err.message}`);
    });

    proxyReq.write(forwarded);
    proxyReq.end();
  });
});

server.listen(PORT, () => {
  console.log(`RPC proxy listening on :${PORT} → devnet :5050`);
});
