# Set up the optional cloud AI check

GrammarMe's spelling and grammar checks run on your device and need no setup. The **AI check**
(clearer wording, tone) is optional. It needs a small server that **you** run on your own free
Cloudflare account, so your text goes only to your server and the AI provider you pick, never to
the GrammarMe project.

This guide is for the **web editor**. The Chrome extension doesn't use this server. Its optional AI
check uses [your ChatGPT plan](chatgpt.md) instead.

You need to type a few commands in a terminal. You don't need to write any code.

## What you need

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up).
- [Node.js](https://nodejs.org) 22.6 or newer.
- Optional: a free [Groq API key](https://console.groq.com/keys). Without one, the server uses
  Cloudflare's own Workers AI, which is included in the free account (10,000 "Neurons" a day).

Before choosing a provider, read [what each provider does with your text](llm-research.md).

## Steps

1. **Get the code.** Download the repository
   ([zip](https://github.com/bachnguyennn/GrammarMe/archive/refs/heads/main.zip)) and unzip it, or
   `git clone https://github.com/bachnguyennn/GrammarMe.git`. Then, in a terminal:

   ```sh
   cd GrammarMe
   npm install
   cd workers/ai-api
   ```

2. **Sign in to Cloudflare.** This opens your browser:

   ```sh
   npx wrangler login
   ```

3. **Create your access token.** This is the password the editor uses to talk to your server.
   Make a long random one and save it somewhere safe (a password manager is ideal):

   ```sh
   openssl rand -base64 32
   ```

   Then store it on the server, pasting it when asked:

   ```sh
   npx wrangler secret put GRAMMARME_CLIENT_TOKEN
   ```

4. **Optional: add your Groq key.**

   ```sh
   npx wrangler secret put GROQ_API_KEY
   ```

5. **Deploy.**

   ```sh
   npx wrangler deploy
   ```

   It prints your server's address, like `https://grammarme-ai-api.<your-name>.workers.dev`. If it
   complains about `[[ratelimits]]`, delete that block from `wrangler.toml` and deploy again. The
   server then uses a built-in limiter instead.

6. **Connect the editor.** In GrammarMe, open **Settings → Optional cloud AI**, tick **Enable AI
   check button**, paste the address and your access token, and press **Done**. An **AI check**
   button appears at the top. The hosted editor (`https://bachnguyennn.github.io`) is already
   allowed. If you host the editor yourself, add its address to `ALLOWED_ORIGINS` in `wrangler.toml`
   and deploy again.

## What gets sent, and when

Only when you press **AI check**: your whole draft if it is 4,000 characters or less, otherwise the
paragraph around your cursor. It goes to your server, which forwards it to the provider. The server
stores no text and logs no text. It allows 10 requests a minute and 200 a day by default.

Technical details: [`workers/ai-api/README.md`](../workers/ai-api/README.md).
