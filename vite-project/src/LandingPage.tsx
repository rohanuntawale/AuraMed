import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

type Props = {
  onEnter: () => void
}

type RevealProps = {
  children: ReactNode
  className?: string
  delayMs?: number
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(!!m.matches)
    onChange()
    m.addEventListener?.('change', onChange)
    return () => m.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

function useReveal<T extends Element>() {
  const ref = useRef<T | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.15 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return { ref, visible }
}

function Reveal({ children, className, delayMs }: RevealProps) {
  const { ref, visible } = useReveal<HTMLDivElement>()
  return (
    <div
      ref={ref}
      className={`om-reveal ${visible ? 'om-reveal--in' : ''} ${className || ''}`}
      style={delayMs ? ({ ['--om-delay' as any]: `${delayMs}ms` } as any) : undefined}
    >
      {children}
    </div>
  )
}

function AnimatedNumber({ value, suffix }: { value: number; suffix?: string }) {
  const reduced = usePrefersReducedMotion()
  const [shown, setShown] = useState(0)

  useEffect(() => {
    if (reduced) {
      setShown(value)
      return
    }

    let raf = 0
    const start = performance.now()
    const from = 0
    const duration = 900

    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      setShown(Math.round(from + (value - from) * eased))
      if (p < 1) raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, reduced])

  return (
    <span>
      {shown}
      {suffix || ''}
    </span>
  )
}

function ParticleCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const reduced = usePrefersReducedMotion()

  const palette = useMemo(
    () => [
      'rgba(214,186,120,0.60)',
      'rgba(143,200,188,0.55)',
      'rgba(241,238,232,0.25)',
    ],
    [],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    let raf = 0

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const state = {
      w: 0,
      h: 0,
      mx: 0,
      my: 0,
      t: 0,
      dots: [] as Array<{
        x: number
        y: number
        vx: number
        vy: number
        r: number
        c: string
      }>,
    }

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      state.w = Math.max(1, Math.floor(rect.width))
      state.h = Math.max(1, Math.floor(rect.height))
      canvas.width = Math.floor(state.w * dpr)
      canvas.height = Math.floor(state.h * dpr)
      canvas.style.width = `${state.w}px`
      canvas.style.height = `${state.h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const count = Math.max(38, Math.floor((state.w * state.h) / 22000))
      const dots = [] as typeof state.dots
      for (let i = 0; i < count; i += 1) {
        const sp = 0.18 + Math.random() * 0.46
        const a = Math.random() * Math.PI * 2
        dots.push({
          x: Math.random() * state.w,
          y: Math.random() * state.h,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          r: 1.2 + Math.random() * 2.4,
          c: palette[Math.floor(Math.random() * palette.length)]!,
        })
      }
      state.dots = dots
    }

    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      state.mx = (e.clientX - rect.left) / rect.width
      state.my = (e.clientY - rect.top) / rect.height
    }

    resize()

    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', onMove, { passive: true })

    const draw = () => {
      if (reduced) {
        ctx.clearRect(0, 0, state.w, state.h)
        return
      }

      state.t += 1
      ctx.clearRect(0, 0, state.w, state.h)

      const px = (state.mx - 0.5) * 2
      const py = (state.my - 0.5) * 2

      for (const p of state.dots) {
        const driftX = px * 0.06
        const driftY = py * 0.06

        p.x += p.vx + driftX
        p.y += p.vy + driftY

        if (p.x < -20) p.x = state.w + 20
        if (p.x > state.w + 20) p.x = -20
        if (p.y < -20) p.y = state.h + 20
        if (p.y > state.h + 20) p.y = -20

        ctx.beginPath()
        ctx.fillStyle = p.c
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      }

      const maxLink = 110
      ctx.lineWidth = 1
      for (let i = 0; i < state.dots.length; i += 1) {
        for (let j = i + 1; j < state.dots.length; j += 1) {
          const a = state.dots[i]!
          const b = state.dots[j]!
          const dx = a.x - b.x
          const dy = a.y - b.y
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d > maxLink) continue
          const alpha = (1 - d / maxLink) * 0.20
          ctx.strokeStyle = `rgba(241,238,232,${alpha.toFixed(3)})`
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
      }

      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onMove)
    }
  }, [palette, reduced])

  return <canvas ref={canvasRef} className="om-particles" />
}

export default function LandingPage({ onEnter }: Props) {
  return (
    <div id="top" className="min-h-full">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0">
          <ParticleCanvas />
          <div className="om-aurora" />
          <div className="om-orb om-orb--gold" />
          <div className="om-orb om-orb--emerald" />
          <div className="om-orb om-orb--pearl" />
        </div>

        <div className="relative mx-auto max-w-6xl px-4 pt-10 pb-14">
          <div className="flex items-center justify-between gap-4">
            <div className="om-serif text-xl" style={{ color: 'var(--om-text)' }}>
              AuraMed
            </div>
            <div className="flex items-center gap-2">
              <button className="om-button px-3 py-2 text-xs" onClick={onEnter}>
                Open Dashboard
              </button>
            </div>
          </div>

          <div className="mt-10 grid grid-cols-1 items-center gap-8 md:grid-cols-2">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs" style={{ borderColor: 'rgba(255,255,255,0.14)', background: 'rgba(0,0,0,0.18)' }}>
                <span style={{ color: 'rgba(214,186,120,0.95)' }}>Offline-first</span>
                <span style={{ color: 'var(--om-muted)' }}>OPD queue orchestration</span>
              </div>

              <h1 className="om-serif mt-4 text-4xl leading-tight md:text-5xl" style={{ color: 'var(--om-text)' }}>
                Predictable flow.
                <br />
                Human-safe promises.
              </h1>

              <p className="mt-4 text-base md:text-lg" style={{ color: 'var(--om-muted)' }}>
                AuraMed helps clinics run faster OPD days with session-bound FIFO tokens, elastic arrival windows, emergency absorption, and
                offline-first staff operations.
              </p>

              <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
                <button className="om-button-primary px-5 py-3 text-sm font-semibold" onClick={onEnter}>
                  Launch Dashboard
                </button>
                <a className="om-button px-5 py-3 text-sm font-semibold" href="#how">
                  See how it works
                </a>
              </div>

              <div className="mt-6 grid grid-cols-3 gap-3">
                <div className="om-card px-4 py-4">
                  <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
                    Tokens
                  </div>
                  <div className="om-serif mt-2 text-2xl">
                    <AnimatedNumber value={6} suffix="+" />
                  </div>
                </div>
                <div className="om-card px-4 py-4">
                  <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
                    Offline
                  </div>
                  <div className="om-serif mt-2 text-2xl">
                    <AnimatedNumber value={100} suffix="%" />
                  </div>
                </div>
                <div className="om-card px-4 py-4">
                  <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
                    Sync
                  </div>
                  <div className="om-serif mt-2 text-2xl">
                    <AnimatedNumber value={3} suffix="s" />
                  </div>
                </div>
              </div>
            </div>

            <div className="om-card relative overflow-hidden px-5 py-5">
              <div className="om-shine" />
              <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
                What you get
              </div>
              <div className="mt-4 space-y-3">
                <div className="rounded-2xl border px-4 py-4" style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.22)' }}>
                  <div className="text-sm font-semibold" style={{ color: 'var(--om-text)' }}>
                    Elastic arrival windows
                  </div>
                  <div className="mt-1 text-xs" style={{ color: 'var(--om-muted)' }}>
                    Patients see windows, not exact times. Less crowding, fewer broken promises.
                  </div>
                </div>
                <div className="rounded-2xl border px-4 py-4" style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.22)' }}>
                  <div className="text-sm font-semibold" style={{ color: 'var(--om-text)' }}>
                    Emergency absorption
                  </div>
                  <div className="mt-1 text-xs" style={{ color: 'var(--om-muted)' }}>
                    Adds controlled “emergency debt” minutes that consume buffers and breaks.
                  </div>
                </div>
                <div className="rounded-2xl border px-4 py-4" style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.22)' }}>
                  <div className="text-sm font-semibold" style={{ color: 'var(--om-text)' }}>
                    Offline-first staff workflow
                  </div>
                  <div className="mt-1 text-xs" style={{ color: 'var(--om-muted)' }}>
                    Actions queue locally and auto-sync when internet returns.
                  </div>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl border px-4 py-4" style={{ borderColor: 'rgba(214,186,120,0.22)', background: 'rgba(214,186,120,0.08)' }}>
                <div>
                  <div className="text-xs uppercase tracking-wide" style={{ color: 'rgba(214,186,120,0.95)' }}>
                    Safety note
                  </div>
                  <div className="mt-1 text-xs" style={{ color: 'var(--om-muted)' }}>
                    No diagnosis. No treatment advice. No exact-time guarantees.
                  </div>
                </div>
                <div className="om-pulse-dot" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-4 pb-16">
        <Reveal className="mt-10" delayMs={0}>
          <div id="how" className="grid grid-cols-1 gap-6 md:grid-cols-3">
            <div className="om-card px-5 py-5">
              <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
                1. Start a session
              </div>
              <div className="om-serif mt-2 text-2xl">Daily OPD rhythm</div>
              <div className="mt-2 text-sm" style={{ color: 'var(--om-muted)' }}>
                Define slot length, micro-buffers, break cadence, and emergency reserve. Then operate in real time.
              </div>
            </div>
            <div className="om-card px-5 py-5">
              <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
                2. Book tokens
              </div>
              <div className="om-serif mt-2 text-2xl">FIFO + windows</div>
              <div className="mt-2 text-sm" style={{ color: 'var(--om-muted)' }}>
                Intake creates a neutral urgency label and summary. Booking returns an arrival window (not a timestamp).
              </div>
            </div>
            <div className="om-card px-5 py-5">
              <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
                3. Run the queue
              </div>
              <div className="om-serif mt-2 text-2xl">Serve, skip, emergency</div>
              <div className="mt-2 text-sm" style={{ color: 'var(--om-muted)' }}>
                Reception marks arrivals; staff serve next; urgent cases add emergency debt while preserving breaks.
              </div>
            </div>
          </div>
        </Reveal>

        <Reveal className="mt-10" delayMs={80}>
          <div className="om-card px-6 py-6">
            <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
              <div>
                <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
                  Built for real clinics
                </div>
                <div className="om-serif mt-2 text-3xl">Works through internet drops</div>
                <div className="mt-2 text-sm" style={{ color: 'var(--om-muted)' }}>
                  Patient and staff actions are designed to keep moving even when connectivity doesn’t.
                </div>
              </div>
              <div className="flex w-full max-w-md gap-3">
                <div className="flex-1 rounded-2xl border px-4 py-4" style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.20)' }}>
                  <div className="text-xs" style={{ color: 'var(--om-muted)' }}>
                    Offline queue
                  </div>
                  <div className="om-serif mt-2 text-2xl">Auto-sync</div>
                </div>
                <div className="flex-1 rounded-2xl border px-4 py-4" style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.20)' }}>
                  <div className="text-xs" style={{ color: 'var(--om-muted)' }}>
                    Minimal UI
                  </div>
                  <div className="om-serif mt-2 text-2xl">Fast ops</div>
                </div>
              </div>
            </div>
          </div>
        </Reveal>

        <Reveal className="mt-10" delayMs={120}>
          <div className="relative overflow-hidden rounded-3xl border px-7 py-8" style={{ borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.22)' }}>
            <div className="om-cta-bg" />
            <div className="relative flex flex-col items-start justify-between gap-5 md:flex-row md:items-center">
              <div>
                <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--om-muted)' }}>
                  Ready to try the MVP?
                </div>
                <div className="om-serif mt-2 text-3xl">Open the live dashboard</div>
                <div className="mt-2 text-sm" style={{ color: 'var(--om-muted)' }}>
                  Start as a patient to book a token, or switch to staff mode to operate the queue.
                </div>
              </div>
              <div className="flex gap-3">
                <button className="om-button-primary px-6 py-3 text-sm font-semibold" onClick={onEnter}>
                  Enter
                </button>
                <a className="om-button px-6 py-3 text-sm font-semibold" href="#top">
                  Back to top
                </a>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </div>
  )
}
