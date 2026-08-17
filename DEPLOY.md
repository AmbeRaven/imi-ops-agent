# Deploy IMI Ops Agent on Render

Create a new Render Web Service from this repository/package. The included `render.yaml` defines the service.

Required secrets:
- `OPENAI_API_KEY` — your OpenAI Platform key
- `BROWSERBASE_API_KEY` — your Browserbase key
- `BROWSERBASE_PROJECT_ID` — optional; add it if Browserbase requires it for your account
- `IMI_AGENT_PASSCODE` — choose a passcode only you know; the web UI will ask for it

The app exposes `/health` for Render health checks.
