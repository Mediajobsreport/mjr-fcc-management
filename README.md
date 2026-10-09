# MJR FCC Management

This repository contains the FCC Management Dashboard and its server-side transaction adapter.

## Files

- `index.html` - Dashboard prototype with station profile reminders, Radio/Television selection, FCC export import, and live-refresh hook.
- `fcc_transactions_worker.js` - Cloudflare Worker for `/api/fcc/transactions`.
- `wrangler.toml` - Cloudflare deployment configuration with a daily Cron Trigger and KV cache binding.

## Required setup

1. Create a Cloudflare KV namespace and replace the placeholder ID in `wrangler.toml`.
2. Set `FCC_LMS_TRANSACTIONS_URL` to an approved FCC LMS export or MJR-controlled normalized feed.
3. Deploy the Worker and map it to the MJR dashboard route.
4. Test `/api/fcc/transactions?service=radio` and `/api/fcc/transactions?service=television` before publishing.

The Worker stores separate cached Radio, Television, and combined datasets. The public dashboard reads the selected category from cache instead of downloading the FCC source for each visitor.

Records missing a file number, station call sign, status, or status date are returned with `review: true` so they can be held for review.
