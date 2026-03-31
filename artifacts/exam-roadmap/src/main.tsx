import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@/api-client";
import App from "./App";
import "./index.css";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;

if (apiBaseUrl && apiBaseUrl.trim() !== "") {
  setBaseUrl(apiBaseUrl);
}

createRoot(document.getElementById("root")!).render(<App />);

