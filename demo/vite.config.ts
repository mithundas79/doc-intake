import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    // The library uses NodeNext-style `./x.js` specifiers in its TS source;
    // strip the extension so Vite resolves the .ts files directly.
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1" }],
  },
});
