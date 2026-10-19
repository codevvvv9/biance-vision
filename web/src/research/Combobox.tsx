/**
 * 自由输入 + 深色补全面板（替换原生 datalist：浏览器不给 datalist 弹层任何定制权限，
 * macOS/Windows 上都是系统白色菜单）。弹层复用 Dropdown 的 .dd-list/.dd-option 样式，
 * 视觉完全同源。过滤：前缀优先、其次包含（大小写不敏感），最多 10 项；空输入或与某项
 * 完全相等时展示前 10 个。键盘：↑/↓ 导航、Enter 选活动项（无活动项则收起保留输入）、
 * Esc/Tab 收起；选项在 pointerdown 阶段选中（click 前焦点转移会先触发 blur 收起面板）。
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'

const MAX_ITEMS = 10

export function Combobox(props: {
  value: string
  onChange: (value: string) => void
  suggestions: ReadonlyArray<string>
  ariaLabel: string
  inputClassName?: string
  disabled?: boolean
}): JSX.Element {
  const { value, onChange, suggestions, ariaLabel, inputClassName, disabled = false } = props
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const listId = useId()

  const query = value.trim().toUpperCase()
  const items = useMemo(() => {
    if (query === '' || suggestions.some((s) => s.toUpperCase() === query)) return suggestions.slice(0, MAX_ITEMS)
    const starts = suggestions.filter((s) => s.toUpperCase().startsWith(query))
    const contains = suggestions.filter((s) => !starts.includes(s) && s.toUpperCase().includes(query))
    return [...starts, ...contains].slice(0, MAX_ITEMS)
  }, [query, suggestions])
  const activeId = active >= 0 && active < items.length ? `cb-opt-${active}` : undefined

  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  useEffect(() => {
    if (activeId === undefined || listRef.current === null) return
    listRef.current.querySelector(`#${activeId}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  // 输入变化重置活动项；无匹配时收起
  useEffect(() => setActive(-1), [query])
  useEffect(() => {
    if (items.length === 0) setOpen(false)
  }, [items.length])

  const pick = (s: string): void => {
    onChange(s)
    setOpen(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (items.length === 0) return
      e.preventDefault()
      if (!open) {
        setOpen(true)
        setActive(e.key === 'ArrowDown' ? 0 : items.length - 1)
        return
      }
      setActive((cur) => {
        const base = cur < 0 ? (e.key === 'ArrowDown' ? -1 : items.length) : cur
        return (base + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      })
    } else if (e.key === 'Enter') {
      if (open && active >= 0 && items[active] !== undefined) {
        e.preventDefault()
        pick(items[active])
      } else {
        setOpen(false)
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="cb" ref={rootRef}>
      <input
        className={inputClassName}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? activeId : undefined}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => {
          if (items.length > 0) setOpen(true)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      />
      {open && items.length > 0 && (
        <ul className="dd-list cb-list" id={listId} role="listbox" aria-label={ariaLabel} ref={listRef}>
          {items.map((s, i) => (
            <li
              key={s}
              id={`cb-opt-${i}`}
              className="dd-option"
              role="option"
              aria-selected={s.toUpperCase() === query || undefined}
              data-active={i === active || undefined}
              onPointerEnter={() => setActive(i)}
              onPointerDown={() => pick(s)}
            >
              <span>{s}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
