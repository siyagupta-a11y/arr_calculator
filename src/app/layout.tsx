import type { ReactNode } from "react";
import HardRefreshButton from "./HardRefreshButton";
import "./globals.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <HardRefreshButton />
      </body>
    </html>
  );
}
