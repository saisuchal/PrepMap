import { createRoot } from "react-dom/client";
import { setAuthTokenGetter, setBaseUrl } from "@/api-client";
import { getStoredAccessToken } from "@/lib/auth";
import App from "./App";
import "./index.css";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;

if (apiBaseUrl && apiBaseUrl.trim() !== "") {
  setBaseUrl(apiBaseUrl);
}

setAuthTokenGetter(() => getStoredAccessToken());

createRoot(document.getElementById("root")!).render(<App />);

