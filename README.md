# ʻIMI Ops Agent — MVP

A private browser agent for tedious business setup tasks. It combines:

- **OpenAI Responses API** for planning and tool use.
- **Browserbase** for a remote browser session with Live View.
- **Playwright** for browser navigation and form filling.
- A mandatory **human approval gate** before consequential actions.
- Manual takeover for passwords, MFA, CAPTCHA, payments, uploads, and other sensitive steps.

## What this first version can do

Ask it things like:

- “Set up the ʻIMI Analytics Google Business Profile with our saved business details.”
- “Create the ʻIMI Analytics LinkedIn company page. Stop before publishing.”
- “Fill out this vendor application using our business profile, but don’t submit it.”

It can navigate, read pages, click ordinary controls, fill non-sensitive fields, and select options. It pauses before final actions such as publish/submit/create/send and asks you to approve.

## What it intentionally will NOT do

It does not type passwords, OTP/MFA codes, payment-card data, or bypass CAPTCHA/bot protections. Use Browserbase **Live View** to take over for those steps.

## Setup

1. Install Node.js 20+.
2. Create an OpenAI API key.
3. Create a Browserbase account/project and copy the API key + Project ID.
4. Copy `.env.example` to `.env` and fill in the three keys.
5. In this folder run:

```bash
npm install
npm start
```

6. Open `http://localhost:3000`.
7. Tap **Start Browser**. Then give the agent a task.

## Hosting

This app needs a normal Node server because it connects to a remote Chromium session using Playwright/CDP. A small Node host/container (Render, Railway, Fly.io, etc.) is a better fit than a static site host. Keep it private; do not expose it publicly without adding authentication.

## Security notes

- Never put your OpenAI or Browserbase keys in the browser/client code. They belong only in server environment variables.
- Treat the Browserbase Live View link as sensitive while a session is active.
- The app uses `store:false` for OpenAI Responses requests.
- The server enforces an approval pause for likely consequential click labels in addition to instructing the model to ask first.
- This is an MVP. Before long-term use, add authentication to the control panel and persistent encrypted session state.

## ʻIMI profile

Edit `business-profile.json` to change the business information the agent is allowed to reuse automatically.
