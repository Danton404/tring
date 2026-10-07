# TRING (Trading + Thinking)

Personal PWA for tracking assets against their all-time highs, logging invested capital, planning DCA buys with an allocation pie, and analysing it all with Claude, ChatGPT or DeepSeek.

No build step: plain HTML, CSS and ES modules. Host the folder on GitHub Pages (or any static host) and install it on your phone with "Add to Home Screen".

## Tabs

- **Markets**: price, day change, all-time high and the gain needed to get back there: `(ATH / price - 1) x 100`.
- **Portfolio**: buys and sells, average cost, market value, unrealized and realized P/L, value if everything returned to its ATH, allocation donut, and a daily performance chart (value vs invested).
- **Plan**: either spread a total amount over a period, or invest a fixed amount X per buy. Choose the duration, frequency and start date, then split each buy across assets with a pie. Shows the full schedule; "Log buys" records the buys in Portfolio.
- **AI**: analyse an asset (trend, momentum, RSI, SMAs and volatility from 200 days of data, sentiment, plus news via web search on Claude and ChatGPT), review your portfolio or a plan, or chat about anything. The model sees your app data, so it can do calculations the app doesn't have yet.
- **Settings**: API keys, models, cloud sync, export and import.

## Keys you need

| What | Where | Notes |
|---|---|---|
| Twelve Data | https://twelvedata.com/pricing (free) | Stocks, ETFs, gold (XAU/USD), FX. Free plan: 8 requests/min, 800/day. Raw indices (SPX, IXIC) may need a paid plan, so the defaults use SPY and QQQ. |
| CoinGecko | none | Crypto prices and ATH. |
| Claude | https://console.anthropic.com | Default model `claude-sonnet-5-5` at medium effort (both adjustable in Settings), with web search. |
| ChatGPT | https://platform.openai.com/api-keys | Default model `gpt-5.6-terra`, with web search through the Responses API. |
| Gemini | https://aistudio.google.com/api-keys | Default model `gemini-flash-latest` (free tier), with Google Search grounding. Free-tier prompts may be used by Google to improve its products. |
| DeepSeek | https://platform.deepseek.com | Default model `deepseek-v4-flash`, no web search. |

API keys are stored only in this browser (localStorage) and sent only to their own provider. They are not synced. Use keys with spending limits.

## Cloud sync (Google Apps Script)

1. Go to https://script.google.com and create a new project. Paste in `apps-script/Code.gs`.
2. Run `setup()` once, approve the permissions, and copy the token from the execution log.
3. Deploy > New deployment > Web app. Set Execute as **Me** and Who has access **Anyone**.
4. In TRING > Settings > Cloud sync, paste the `/exec` URL and the token. Do the same on every device.

Data is stored as `tring-data.json` in your Drive. The newest change wins, and the server ignores writes that are older than what it already has.

## Run locally

```bash
python3 -m http.server 8790 -d TRING
```

Then open http://localhost:8790. The `tring` entry in `.claude/launch.json` does the same thing.

## Notes

- Bump `VERSION` in `sw.js` when you change the file list. Shell files load network-first, so ordinary edits show up without a bump.
- ATH for Twelve Data assets is the highest monthly high in the full history (cached for 12 hours). Prices are cached for 5 minutes.
- Plan buys logged with "Log buys" use the current price. If your fill was different, delete the buy and log it again.

## Shared mode (multiple people)

When `js/config.js` has a Supabase URL and publishable key, TRING runs in shared mode:

- People sign in with Google. Only emails in the `allowed_emails` table get in.
- Each person's assets, transactions and plans are stored in `user_state`, protected by row-level security.
- API keys live on the server as Edge Function secrets. Users never see them and need none of their own.
- `market` function: Twelve Data proxy with a shared cache (`market_cache`), so everyone together stays inside the free limit.
- `ai` function: Claude / ChatGPT / Gemini / DeepSeek proxy with a per-user daily limit (`DAILY_AI_LIMIT`, default 25).

Supabase project: `rqmybqdyfsrnkmbvaadx` (org TRING). Google OAuth client: Google Cloud project "TRING" (`numeric-zoo-510918-i9`).

| Task | Where |
|---|---|
| Give someone access | Supabase > Table Editor > `allowed_emails` > Insert row (email in lowercase) |
| Add or change API keys | Supabase > Edge Functions > Secrets: `TWELVE_DATA_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID` (optional), `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `DAILY_AI_LIMIT` |
| Allow a new site address | Supabase > Authentication > URL Configuration (Site URL + Redirect URLs) |
| Update server code | Paste `supabase/functions/<name>/index.ts` into Edge Functions > the function > Code, then Deploy. "Verify JWT with legacy secret" stays off; the functions check the user themselves. |
| Database changes | Re-run `supabase/schema.sql` in the SQL Editor (safe to re-run) |

To go back to single-user mode, empty both values in `js/config.js`.
