import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { lazy, Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import "./index.css";

import { StrataAuthProvider } from "./components/AuthProvider";
import { Layout } from "./components/Layout";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { StackDetail } from "./pages/StackDetail";
import { StackList } from "./pages/StackList";
import { UpdateDetail } from "./pages/UpdateDetail";
import { createTRPCClient, trpc } from "./trpc";

const LoginPage = lazy(() => import("./pages/Login").then((m) => ({ default: m.Login })));

const LoginFallback = (
	<div className="min-h-screen bg-zinc-950 flex items-center justify-center">
		<div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" />
	</div>
);

function handleGlobalError(error: unknown) {
	if (
		error instanceof TRPCClientError &&
		error.data?.httpStatus === 401 &&
		window.location.pathname !== "/login"
	) {
		window.location.href = "/login";
	}
}

function App() {
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						retry: false,
						refetchOnWindowFocus: false,
					},
					mutations: {
						onError: handleGlobalError,
					},
				},
				queryCache: new QueryCache({
					onError: handleGlobalError,
				}),
			}),
	);
	const [trpcClient] = useState(createTRPCClient);

	return (
		<StrataAuthProvider>
			<trpc.Provider client={trpcClient} queryClient={queryClient}>
				<QueryClientProvider client={queryClient}>
					<BrowserRouter>
						<Routes>
							<Route
								path="/login"
								element={
									<Suspense fallback={LoginFallback}>
										<LoginPage />
									</Suspense>
								}
							/>
							<Route element={<ProtectedRoute />}>
								<Route path="/" element={<Layout />}>
									<Route index element={<StackList />} />
									<Route path="stacks/:org/:project/:stack" element={<StackDetail />} />
									<Route
										path="stacks/:org/:project/:stack/updates/:updateID"
										element={<UpdateDetail />}
									/>
									{/* CLI-generated "View in Browser" URLs omit /stacks/ prefix */}
									<Route path=":org/:project/:stack" element={<StackDetail />} />
									<Route path=":org/:project/:stack/updates/:updateID" element={<UpdateDetail />} />
								</Route>
							</Route>
						</Routes>
					</BrowserRouter>
				</QueryClientProvider>
			</trpc.Provider>
		</StrataAuthProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<App />);
}
