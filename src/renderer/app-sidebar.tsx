import { Gamepad2, Globe2, Wrench } from "./icons.js";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { type AppNavigationTarget, type SidebarPage } from "./routes.js";
import brandMark from "../shared/assets/ohmygame-mark-v2.svg";
import { t } from "./i18n.js";

interface AppSidebarProps {
  active: SidebarPage;
  onNavigate: (page: AppNavigationTarget) => void;
}

const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 208;
const MAX_SIDEBAR_WIDTH = 272;
const SIDEBAR_WIDTH_STORAGE_KEY = "ohmygame-sidebar-width";

export function AppSidebar({ active, onNavigate }: AppSidebarProps) {
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  const resizingRef = useRef(false);

  useLayoutEffect(() => {
    sidebar.current?.parentElement?.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  }, [sidebarWidth]);

  useEffect(() => {
    if (window.matchMedia("(max-width: 720px)").matches) {
      sidebar.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [active]);

  function resize(clientX: number): void {
    const shell = sidebar.current?.parentElement;
    const bounds = shell?.getBoundingClientRect();
    if (!shell || !bounds) return;
    const width = clampSidebarWidth(Math.round(clientX - bounds.left));
    sidebarWidthRef.current = width;
    shell.style.setProperty("--sidebar-width", `${width}px`);
  }

  function finishResize(): void {
    if (!resizingRef.current) return;
    resizingRef.current = false;
    setResizing(false);
    setSidebarWidth(sidebarWidthRef.current);
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidthRef.current));
  }

  function resetWidth(): void {
    sidebarWidthRef.current = DEFAULT_SIDEBAR_WIDTH;
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(DEFAULT_SIDEBAR_WIDTH));
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const nextWidth = clampSidebarWidth(sidebarWidthRef.current + direction * 8);
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth));
  }

  return (
    <aside className={`home-sidebar${resizing ? " home-sidebar-resizing" : ""}`} ref={sidebar}>
      {resizing ? <div className="home-sidebar-resize-shield" /> : null}
      <div className="home-sidebar-header-spacer" aria-hidden="true" />
      <div className="home-sidebar-brand">
        <img src={brandMark} alt="OhMyGame" />
        <span>OhMyGame</span>
      </div>
      <nav aria-label={t("sidebar.mainNavigation")}>
        <NavigationItem active={active === "home"} icon="home" label={t("sidebar.home")} onClick={() => onNavigate("home")} />
        <NavigationItem active={active === "projects"} icon="project" label={t("sidebar.projects")} onClick={() => onNavigate("projects")} />
        <NavigationItem active={active === "library"} icon="library" label={t("sidebar.library")} onClick={() => onNavigate("library")} />
        <NavigationItem active={active === "plugins"} icon="plugins" label={t("sidebar.plugins")} onClick={() => onNavigate("plugins")} />
        <div className="home-nav-label home-nav-label-spaced">{t("sidebar.studios")}</div>
        <NavigationItem active={active === "web-game"} icon="web-game" label={t("projectType.web-game")} onClick={() => onNavigate("web-game")} />
        <NavigationItem active={active === "interactive-story"} icon="interactive-story" label={t("projectType.interactive-story")} onClick={() => onNavigate("interactive-story")} />
        <NavigationItem active={active === "godot"} icon="godot" label={t("projectType.godot-game")} onClick={() => onNavigate("godot")} />
        <NavigationItem active={active === "asset-canvas"} icon="asset-canvas" label={t("projectType.asset-canvas")} onClick={() => onNavigate("asset-canvas")} />
        <NavigationItem active={active === "general"} icon="general" label={t("projectType.general")} onClick={() => onNavigate("general")} />
      </nav>
      <div className="home-sidebar-account">
        <button className="home-sidebar-account-main" type="button" onClick={() => onNavigate("settings")}>
          <Wrench size={16} /><span className="home-sidebar-account-name">{t("common.settings")}</span>
        </button>
      </div>
      <div
        className="home-sidebar-resizer"
        role="separator"
        aria-label={t("sidebar.resize")}
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onDoubleClick={resetWidth}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          resizingRef.current = true;
          setResizing(true);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientX);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          finishResize();
        }}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
      />
    </aside>
  );
}

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

export function readSidebarWidth(): number {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : DEFAULT_SIDEBAR_WIDTH;
}

function NavigationItem({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: "home" | "project" | "library" | "general" | "web-game" | "interactive-story" | "godot" | "asset-canvas" | "community" | "plugins";
  label: string;
  onClick: () => void;
}) {
  const content = <>{icon === "web-game" || icon === "general" ? <span className="home-nav-symbol" aria-hidden="true">{icon === "general" ? <Gamepad2 size={16} /> : <Globe2 size={16} />}</span> : <span className={`home-nav-icon home-nav-icon-${icon}`} aria-hidden="true" />}<span>{label}</span></>;
  return (
    <button
      className={`home-nav-item${active ? " home-nav-item-active" : ""}`}
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
    >
      {content}
    </button>
  );
}
