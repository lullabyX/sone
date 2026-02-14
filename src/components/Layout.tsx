import Sidebar from "./Sidebar";
import Header from "./Header";
import PlayerBar from "./PlayerBar";
import NowPlayingDrawer from "./NowPlayingDrawer";
import { ReactNode } from "react";

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  return (
    <div className="flex flex-col h-full w-full bg-th-overlay text-white overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0 bg-th-base">
          <Header />
          <div className="flex-1 overflow-y-auto custom-scrollbar relative">
            {children}
          </div>
        </div>
      </div>
      <NowPlayingDrawer />
      <PlayerBar />
    </div>
  );
}
