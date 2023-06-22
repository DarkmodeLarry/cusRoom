import { Analytics } from "@vercel/analytics/react";

import "../styles/globals.css";

let title = "Dream Room Generator";
let description = "Generate your dream room in seconds.";
let ogimage = "#";
let sitename = "cusRoom.io";


export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-[#17181C] text-white">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
