import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { lazy, Suspense, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import "./index.css";

import { ProcellaAuthProvider } from "./components/AuthProvider";
import { FullPageSpinner } from "./components/FullPageSpinner";
import { HomeRoute } from "./components/HomeRoute";
import { Layout } from "./components/Layout";
import { CliLogin } from "./pages/CliLogin";
import { ResourceDetail } from "./pages/ResourceDetail";
import { Settings } from "./pages/Settings";
import { StackDetail } from "./pages/StackDetail";
import { StackList } from "./pages/StackList";
import { Tokens } from "./pages/Tokens";
import { UpdateDetail } from "./pages/UpdateDetail";
import { WelcomeCli } from "./pages/WelcomeCli";
import { createTRPCClient, trpc } from "./trpc";

const LoginPage = lazy(() => import("./pages/Login").then((m) => ({ default: m.Login })));

const LoginFallback = <FullPageSpinner />;

function handleGlobalError(error: unknown) {
	if (
		error instanceof TRPCClientError &&
		error.data?.httpStatus === 401 &&
		window.location.pathname !== "/login"
	) {
		window.location.href = "/login";
	}
}

function TRPCProvider({ children }: { children: React.ReactNode }) {
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

	const trpcClient = useMemo(createTRPCClient, []);

	return (
		<trpc.Provider client={trpcClient} queryClient={queryClient}>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</trpc.Provider>
	);
}

function App() {
	return (
		<ProcellaAuthProvider>
			<TRPCProvider>
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
						<Route path="/cli-login" element={<CliLogin />} />
						<Route path="/welcome/cli" element={<WelcomeCli />} />
						<Route element={<HomeRoute />}>
							<Route path="/" element={<Layout />}>
								<Route index element={<StackList />} />
								<Route path="tokens" element={<Tokens />} />
								<Route path="settings" element={<Settings />} />
								<Route path="stacks/:org/:project/:stack" element={<StackDetail />} />
								<Route path="stacks/:org/:project/:stack/resources" element={<ResourceDetail />} />
								<Route
									path="stacks/:org/:project/:stack/updates/:updateID"
									element={<UpdateDetail />}
								/>
								{/* CLI-generated "View in Browser" URLs omit /stacks/ prefix */}
								<Route path=":org/:project/:stack" element={<StackDetail />} />
								<Route path=":org/:project/:stack/resources" element={<ResourceDetail />} />
								<Route path=":org/:project/:stack/updates/:updateID" element={<UpdateDetail />} />
							</Route>
						</Route>
					</Routes>
				</BrowserRouter>
			</TRPCProvider>
		</ProcellaAuthProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<App />);
}
