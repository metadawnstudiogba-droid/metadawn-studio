import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = { title: "Metadawn studio", description: "Seedance 视频创作工作台 · 自备供应商和私有存储" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
