import type { Metadata } from "next";
import "./pos-v2.css";

export const metadata: Metadata = {
  title: "점핑배틀 POS V2",
  manifest: "/manifest.webmanifest",
};

export default function PosV2Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
