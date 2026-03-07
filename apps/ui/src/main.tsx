import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import "./index.css";

import { Layout } from "./components/Layout";
import { StackDetail } from "./pages/StackDetail";
import { StackList } from "./pages/StackList";
import { UpdateDetail } from "./pages/UpdateDetail";
import { createTRPCClient, trpc } from "./trpc";

function App() {
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						retry: false,
						refetchOnWindowFocus: false,
					},
				},
			}),
	);
	const [trpcClient] = useState(createTRPCClient);

	return (
		<trpc.Provider client={trpcClient} queryClient={queryClient}>
			<QueryClientProvider client={queryClient}>
				<BrowserRouter>
					<Routes>
						<Route path="/" element={<Layout />}>
							<Route index element={<StackList />} />
							<Route path="stacks/:org/:project/:stack" element={<StackDetail />} />
							<Route
								path="stacks/:org/:project/:stack/updates/:updateID"
								element={<UpdateDetail />}
							/>
						</Route>
					</Routes>
				</BrowserRouter>
			</QueryClientProvider>
		</trpc.Provider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<App />);
}
