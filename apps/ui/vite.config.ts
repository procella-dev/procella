import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API_PORT = process.env.VITE_API_PORT ?? "9090";
const apiTarget = `http://127.0.0.1:${API_PORT}`;

export default defineConfig({
	plugins: [react(), tailwindcss()],
	build: {
		outDir: "dist",
	},
	base: "/",
	server: {
		proxy: {
			"/trpc": apiTarget,
			"/api": apiTarget,
			"/healthz": apiTarget,
		},
	},
});
