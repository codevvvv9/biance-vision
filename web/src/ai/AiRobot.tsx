import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { lsGet, lsSet } from '../utils'

interface Props {
  onOpen: () => void
  onHide: () => void
  /** 聊天窗打开时机器人退场，避免遮挡面板内容 */
  hidden?: boolean
}

const SIZE = 104
const POS_KEY = 'bv.aiRobotPos'

/**
 * 3D 悬浮机器人（three.js 程序化建模，无外部模型文件）：
 * - 左键点按拖拽移动（位置记忆到 localStorage，限定在视口内）
 * - 单击（未拖动）→ 打开聊天窗口
 * - 右键 → 隐藏（顶栏菜单可再次唤起）
 */
export default function AiRobot({ onOpen, onHide, hidden = false }: Props): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasHostRef = useRef<HTMLDivElement | null>(null)
  const hoverRef = useRef(false)
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null)

  // ---- three.js 场景：一次性搭建，动画循环里做悬浮/眨眼/悬停缩放 ----
  useEffect(() => {
    const host = canvasHostRef.current
    if (!host) return undefined

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50)
    camera.position.set(0, 0.35, 7.4)
    camera.lookAt(0, 0.15, 0)
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(SIZE, SIZE)
    host.appendChild(renderer.domElement)

    scene.add(new THREE.AmbientLight(0x8fb4ff, 1.7))
    const dir = new THREE.DirectionalLight(0xffffff, 1.8)
    dir.position.set(3, 5, 4)
    scene.add(dir)
    const cyanLight = new THREE.PointLight(0x00e5ff, 20, 14)
    cyanLight.position.set(-2.5, 1, 3)
    scene.add(cyanLight)

    const shell = new THREE.MeshStandardMaterial({ color: 0x37568c, metalness: 0.65, roughness: 0.32 })
    const face = new THREE.MeshStandardMaterial({ color: 0x0a1120, metalness: 0.4, roughness: 0.22 })
    const glow = new THREE.MeshStandardMaterial({ color: 0x00e5ff, emissive: 0x00e5ff, emissiveIntensity: 2.4 })
    const white = new THREE.MeshStandardMaterial({ color: 0xdfe9ff, metalness: 0.3, roughness: 0.4 })

    const body = new THREE.Group()

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.62, 32, 24), shell)
    head.scale.set(1, 0.82, 0.9)
    head.position.y = 0.78
    body.add(head)

    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 20, 0, Math.PI * 2, 0, Math.PI * 0.5), face)
    visor.rotation.x = -Math.PI / 2
    visor.position.set(0, 0.76, 0.14)
    body.add(visor)

    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), glow)
    eyeL.scale.set(1.35, 0.75, 0.55)
    eyeL.position.set(-0.19, 0.82, 0.55)
    const eyeR = eyeL.clone()
    eyeR.position.x = 0.19
    body.add(eyeL, eyeR)

    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.32, 8), shell)
    antenna.position.y = 1.4
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.085, 16, 12), glow)
    tip.position.y = 1.6
    body.add(antenna, tip)

    const earGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.1, 16)
    const earL = new THREE.Mesh(earGeo, white)
    earL.rotation.z = Math.PI / 2
    earL.position.set(-0.62, 0.78, 0)
    const earR = earL.clone()
    earR.position.x = 0.62
    body.add(earL, earR)

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.5, 8, 20), shell)
    torso.position.y = -0.2
    body.add(torso)

    const chest = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), glow)
    chest.position.set(0, 0.02, 0.4)
    body.add(chest)

    const armGeo = new THREE.CapsuleGeometry(0.12, 0.34, 6, 12)
    const armL = new THREE.Mesh(armGeo, shell)
    armL.position.set(-0.58, -0.12, 0)
    armL.rotation.z = 0.25
    const armR = new THREE.Mesh(armGeo, shell)
    armR.position.set(0.58, -0.12, 0)
    armR.rotation.z = -0.25
    body.add(armL, armR)

    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.66, 0.02, 8, 48), glow)
    ring.rotation.x = Math.PI / 2
    ring.position.y = -1.0
    body.add(ring)

    scene.add(body)

    let raf = 0
    const t0 = performance.now()
    let hoverScale = 1
    const animate = (): void => {
      raf = requestAnimationFrame(animate)
      const t = (performance.now() - t0) / 1000
      body.position.y = Math.sin(t * 1.6) * 0.12
      body.rotation.y = Math.sin(t * 0.5) * 0.35
      armL.rotation.z = 0.25 + Math.sin(t * 1.6 + 1) * 0.12
      armR.rotation.z = -0.25 - Math.sin(t * 1.6) * 0.12
      // 周期性眨眼（eyeL/eyeR 的 y 缩放从 0.75 压到 0.1 再回来）
      const blink = Math.abs(Math.sin(t * 0.9)) > 0.965 ? 0.1 : 0.75
      eyeL.scale.y += (blink - eyeL.scale.y) * 0.35
      eyeR.scale.y = eyeL.scale.y
      hoverScale += ((hoverRef.current ? 1.16 : 1) - hoverScale) * 0.12
      scene.scale.setScalar(hoverScale)
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(raf)
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
        else mat?.dispose()
      })
      renderer.dispose()
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement)
    }
  }, [])

  // ---- 恢复记忆位置 ----
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const pos = lsGet<{ left: number; top: number } | null>(POS_KEY, null)
    if (pos) {
      const x = Math.min(Math.max(pos.left, 8), window.innerWidth - SIZE - 8)
      const y = Math.min(Math.max(pos.top, 8), window.innerHeight - SIZE - 8)
      wrap.style.left = `${x}px`
      wrap.style.top = `${y}px`
      wrap.style.right = 'auto'
      wrap.style.bottom = 'auto'
    }
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    dragRef.current = { startX: e.clientX, startY: e.clientY, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const st = dragRef.current
    const wrap = wrapRef.current
    if (!st || !wrap) return
    const dx = e.clientX - st.startX
    const dy = e.clientY - st.startY
    if (!st.moved && Math.hypot(dx, dy) < 5) return
    if (!st.moved) {
      // 首次转为拖拽：把 right/bottom 定位换成 left/top
      const rect = wrap.getBoundingClientRect()
      wrap.style.left = `${rect.left}px`
      wrap.style.top = `${rect.top}px`
      wrap.style.right = 'auto'
      wrap.style.bottom = 'auto'
      st.moved = true
    }
    const x = Math.min(Math.max(e.clientX - SIZE / 2, 8), window.innerWidth - SIZE - 8)
    const y = Math.min(Math.max(e.clientY - SIZE / 2, 8), window.innerHeight - SIZE - 8)
    wrap.style.left = `${x}px`
    wrap.style.top = `${y}px`
    wrap.classList.add('dragging')
  }

  const onPointerUp = (): void => {
    const st = dragRef.current
    const wrap = wrapRef.current
    dragRef.current = null
    wrap?.classList.remove('dragging')
    if (!st || !wrap) return
    if (st.moved) {
      const rect = wrap.getBoundingClientRect()
      lsSet(POS_KEY, { left: rect.left, top: rect.top })
    } else {
      onOpen()
    }
  }

  return (
    <div
      ref={wrapRef}
      className={hidden ? 'ai-robot-wrap is-hidden' : 'ai-robot-wrap'}
      title="AI 助手：点击对话 · 拖拽移动 · 右键隐藏"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => {
        e.preventDefault()
        onHide()
      }}
      onPointerEnter={() => {
        hoverRef.current = true
      }}
      onPointerLeave={() => {
        hoverRef.current = false
      }}
    >
      <div ref={canvasHostRef} className="ai-robot-canvas" />
    </div>
  )
}
