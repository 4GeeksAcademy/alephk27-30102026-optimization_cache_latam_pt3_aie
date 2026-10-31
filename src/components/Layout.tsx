import { useEffect, useRef } from 'react'
import { BookOpen, Boxes } from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { trackPageView } from '../telemetry'

export function Layout() {
  const location = useLocation()
  const lastTrackedLocation = useRef<string | null>(null)

  useEffect(() => {
    if (lastTrackedLocation.current === location.key) return
    lastTrackedLocation.current = location.key

    if (location.pathname === '/') {
      trackPageView(location.pathname, 'catalog')
      return
    }
    const detailMatch = location.pathname.match(/^\/books\/(\d+)$/)
    if (detailMatch) trackPageView(location.pathname, 'book_detail', Number(detailMatch[1]))
  }, [location.key, location.pathname])

  return (
    <div className="min-h-screen bg-[#f7f7f4] text-[#20231f]">
      <header className="border-b border-[#e8e8e2] bg-[#f7f7f4]/95">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
          <NavLink to="/" className="flex items-center gap-3" aria-label="Estante, inicio">
            <span className="grid size-10 place-items-center rounded-xl bg-[#263d32] text-white">
              <BookOpen size={20} strokeWidth={1.7} />
            </span>
            <span>
              <span className="block text-lg font-semibold tracking-tight">estante</span>
              <span className="block text-[11px] tracking-[0.16em] text-[#777970] uppercase">inventario</span>
            </span>
          </NavLink>
          <NavLink to="/" className="flex items-center gap-2 text-sm text-[#62665f] transition hover:text-[#263d32]">
            <Boxes size={17} />
            <span className="hidden sm:inline">Administración</span>
          </NavLink>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-6xl px-5 pb-8 text-xs text-[#898b84] sm:px-8">
        Gestión de inventario · Estante
      </footer>
    </div>
  )
}
