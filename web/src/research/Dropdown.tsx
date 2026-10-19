/**
 * 自绘下拉（替换原生 <select>）：macOS 上原生弹层是系统白色菜单，无法用 CSS 定制，
 * 与深色主题割裂。本组件与表单输入控件同源视觉（--bg-2/--line-2/6px 圆角），
 * 弹层 --bg-3 + 悬停 --cyan 高亮；纯前端展示选择，不改变数据语义。
 * 键盘：Enter/Space/↓ 打开，↑/↓ 导航（跳过禁用项），Home/End 首末，Enter 选中，Esc/Tab 关闭；
 * 点击外部关闭；焦点始终保留在按钮上，弹层用 aria-activedescendant 跟踪（listbox 模式）。
 * 选项在 pointerdown 阶段选中（click 前焦点转移会先触发 blur 收起弹层）。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

export interface DropdownOption<T extends string | number> {
  value: T
  label: string
  disabled?: boolean
}

export function Dropdown<T extends string | number>(props: {
  value: T
  options: ReadonlyArray<DropdownOption<T>>
  onChange: (value: T) => void
  ariaLabel?: string
  disabled?: boolean
}): JSX.Element {
  const { value, options, onChange, ariaLabel, disabled = false } = props
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const selected = options.find((o) => o.value === value)
  const activeId = active >= 0 && active < options.length ? `dd-opt-${active}` : undefined

  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  // 键盘导航时保持活动项可见
  useEffect(() => {
    if (activeId === undefined || listRef.current === null) return
    listRef.current.querySelector(`#${activeId}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const move = (dir: 1 | -1): void => {
    setActive((cur) => {
      const start = cur < 0 ? options.findIndex((o) => o.value === value) : cur
      let next = start
      for (let i = 0; i < options.length; i++) {
        next = (next + dir + options.length) % options.length
        if (options[next]?.disabled !== true) return next
      }
      return start
    })
  }

  const openMenu = (): void => {
    if (disabled) return
    setActive(options.findIndex((o) => o.value === value))
    setOpen(true)
  }

  const pick = (index: number): void => {
    const opt = options[index]
    if (opt === undefined || opt.disabled) return
    onChange(opt.value)
    setOpen(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        openMenu()
        if (e.key === 'ArrowDown') move(1)
        if (e.key === 'ArrowUp') move(-1)
      }
      return
    }
    if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(options.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(active)
    }
  }

  return (
    <div className={`dd${open ? ' dd-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="dd-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-activedescendant={open ? activeId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      >
        {selected?.label ?? String(value)}
        <svg className="dd-chevron" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul className="dd-list" role="listbox" ref={listRef} aria-label={ariaLabel}>
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`dd-opt-${i}`}
              className="dd-option"
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              data-active={i === active || undefined}
              onPointerEnter={() => setActive(i)}
              onPointerDown={() => pick(i)}
            >
              <span>{o.label}</span>
              {o.value === value && <span className="dd-check" aria-hidden="true">✓</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
