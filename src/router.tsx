// The router exposes route components and navigation hooks as one cohesive public API.
/* oxlint-disable react/only-export-components */
import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";

type RouterLocation = { pathname: string; search: string; hash: string };
type NavigateOptions = { replace?: boolean };
type Navigate = (to: string, options?: NavigateOptions) => void;
type RouteProps = { path: string; element: ReactNode };

const RouterContext = createContext<{ location: RouterLocation; navigate: Navigate } | undefined>(undefined);
const ParamsContext = createContext<Record<string, string>>({});

function readLocation(): RouterLocation {
  return { pathname: window.location.pathname, search: window.location.search, hash: window.location.hash };
}

function routeParams(pattern: string, pathname: string) {
  if (pattern === "*") return {};
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, segment] of patternParts.entries()) {
    const value = pathParts[index] ?? "";
    if (segment.startsWith(":")) {
      try {
        params[segment.slice(1)] = decodeURIComponent(value);
      } catch {
        return undefined;
      }
    } else if (segment !== value) {
      return undefined;
    }
  }
  return params;
}

function useRouterContext() {
  const context = useContext(RouterContext);
  if (!context) throw new Error("Router context is required");
  return context;
}

export function BrowserRouter({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<RouterLocation>(readLocation);
  useEffect(() => {
    const onPopState = () => setLocation(readLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const navigate = useCallback<Navigate>((to, options) => {
    const target = new URL(to, window.location.origin);
    const next = `${target.pathname}${target.search}${target.hash}`;
    if (options?.replace) window.history.replaceState(null, "", next);
    else window.history.pushState(null, "", next);
    setLocation(readLocation());
  }, []);
  const value = useMemo(() => ({ location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function Routes({ children }: { children: ReactNode }) {
  const { location } = useRouterContext();
  for (const child of Children.toArray(children)) {
    if (!isValidElement<RouteProps>(child)) continue;
    const params = routeParams(child.props.path, location.pathname);
    if (!params) continue;
    return <ParamsContext.Provider value={params}>{child.props.element}</ParamsContext.Provider>;
  }
  return null;
}

export function Route(_props: RouteProps) {
  return null;
}

export function Navigate({ to, replace = false }: { to: string; replace?: boolean }) {
  const navigate = useNavigate();
  useEffect(() => navigate(to, { replace }), [navigate, replace, to]);
  return null;
}

export function Link({ to, onClick, ...props }: { to: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const navigate = useNavigate();
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey || props.target === "_blank") return;
    event.preventDefault();
    navigate(to);
  };
  return <a {...props} href={to} onClick={handleClick} />;
}

export function useLocation() {
  return useRouterContext().location;
}

export function useNavigate() {
  return useRouterContext().navigate;
}

export function useParams<T extends Record<string, string | undefined> = Record<string, string | undefined>>() {
  return useContext(ParamsContext) as T;
}
