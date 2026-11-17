# Caveman Vector Studio

A free, browser-based tool that turns AI-generated images (logos, stickers, patches)
into clean, editable, print-ready vector art. Everything runs in your browser; your
images never leave your computer.

**Status:** in development (milestone 2 of 6). Working now: open an image, automatic clean-up and tracing with live settings, before/after views, SVG export.

## Run it locally

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev
```

Then open the address it prints (usually http://localhost:5173).

## Update the live site

Edit, commit and push to `main`. A GitHub Actions workflow builds the app and
publishes it to GitHub Pages automatically.

## Licence

MIT. Bundled fonts (Alfa Slab One, Roboto Slab) are under the SIL Open Font
License; see `public/fonts/`.
