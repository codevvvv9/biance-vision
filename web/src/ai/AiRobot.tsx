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
 * 3D 悬浮机器人（three.js 程序化建模的 WALL-E 造型，无外部模型文件）：
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

    // ---- WALL-E 造型：黄色方块身体 + 望远镜双眼 + 履带底盘 ----
    scene.add(new THREE.AmbientLight(0xdfe6ff, 1.1))
    const key = new THREE.DirectionalLight(0xfff1d6, 1.9)
    key.position.set(3, 5, 4)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0x8fb4ff, 0.5)
    fill.position.set(-4, 2, 2)
    scene.add(fill)
    const cyanLight = new THREE.PointLight(0x00e5ff, 10, 14)
    cyanLight.position.set(-2.5, 1, 3)
    scene.add(cyanLight)

    const yellow = new THREE.MeshStandardMaterial({ color: 0xdca94b, metalness: 0.4, roughness: 0.5 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b3038, metalness: 0.6, roughness: 0.45 })
    const treadMat = new THREE.MeshStandardMaterial({ color: 0x3a4352, metalness: 0.55, roughness: 0.5 })
    const silver = new THREE.MeshStandardMaterial({ color: 0xaab6c8, metalness: 0.85, roughness: 0.3 })
    const lens = new THREE.MeshStandardMaterial({ color: 0x0b0f18, metalness: 0.2, roughness: 0.15 })
    const glow = new THREE.MeshStandardMaterial({ color: 0x00e5ff, emissive: 0x00e5ff, emissiveIntensity: 2.2 })

    const body = new THREE.Group()

    // 履带底盘 + 两侧银色负重轮
    const tread = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 1.15), treadMat)
    tread.position.y = -1.0
    body.add(tread)
    const wheelGeo = new THREE.CylinderGeometry(0.27, 0.27, 0.14, 18)
    const hubGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.16, 12)
    for (const wx of [-0.84, 0.84]) {
      for (const wz of [-0.32, 0.32]) {
        const wheel = new THREE.Mesh(wheelGeo, silver)
        wheel.rotation.z = Math.PI / 2
        wheel.position.set(wx, -1.0, wz)
        body.add(wheel)
        const hub = new THREE.Mesh(hubGeo, dark)
        hub.rotation.z = Math.PI / 2
        hub.position.set(wx * 1.03, -1.0, wz)
        body.add(hub)
      }
    }

    // 躯干（垃圾压缩箱）+ 胸口盖板与指示灯
    const torso = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.95, 1.0), yellow)
    torso.position.y = -0.18
    body.add(torso)
    const chestDoor = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.62, 0.06), dark)
    chestDoor.position.set(0, -0.1, 0.51)
    body.add(chestDoor)
    const chestLight = new THREE.Mesh(new THREE.SphereGeometry(0.07, 14, 10), glow)
    chestLight.position.set(0, -0.1, 0.57)
    body.add(chestLight)
    const waist = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.26, 12), silver)
    waist.position.y = 0.42
    body.add(waist)

    // 头部：方块脑袋 + 侧耳盘 + 望远镜双眼（整组做眨眼动画）
    const head = new THREE.Group()
    head.position.y = 0.95
    body.add(head)
    head.add(new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.6, 0.72), yellow))
    for (const ex of [-0.78, 0.78]) {
      const ear = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.08, 16), silver)
      ear.rotation.z = Math.PI / 2
      ear.position.set(ex, 0, 0)
      head.add(ear)
    }
    const eyes = new THREE.Group()
    eyes.position.set(0, -0.02, 0.18)
    head.add(eyes)
    for (const ex of [-0.42, 0.42]) {
      // 单眼成组，像双筒望远镜一样略向外张
      const eye = new THREE.Group()
      eye.position.x = ex
      eye.rotation.y = ex > 0 ? -0.12 : 0.12
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.21, 0.32, 20), silver)
      tube.rotation.x = Math.PI / 2
      tube.position.z = 0.3
      eye.add(tube)
      const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.165, 0.05, 20), lens)
      glass.rotation.x = Math.PI / 2
      glass.position.z = 0.46
      eye.add(glass)
      const iris = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 10), glow)
      iris.scale.set(1.3, 1, 0.6)
      iris.position.z = 0.45
      eye.add(iris)
      eyes.add(eye)
    }

    // 手臂：肩部枢轴 + 黄色上臂 + 深色前臂与双指爪
    const buildArm = (side: 1 | -1): THREE.Group => {
      const shoulder = new THREE.Group()
      shoulder.position.set(side * 0.74, 0.14, 0)
      shoulder.rotation.z = side * 0.55
      const upper = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.55, 0.16), yellow)
      upper.position.y = -0.27
      shoulder.add(upper)
      const fore = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.38, 0.13), dark)
      fore.position.set(0, -0.68, 0)
      fore.rotation.z = -side * 0.7
      shoulder.add(fore)
      for (const cs of [-1, 1]) {
        const claw = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.08), dark)
        claw.position.set(cs * 0.05, -0.9, 0)
        claw.rotation.z = cs * 0.45
        shoulder.add(claw)
      }
      return shoulder
    }
    const armL = buildArm(-1)
    const armR = buildArm(1)
    body.add(armL, armR)

    scene.add(body)

    let raf = 0
    const t0 = performance.now()
    let hoverScale = 1
    const animate = (): void => {
      raf = requestAnimationFrame(animate)
      const t = (performance.now() - t0) / 1000
      body.position.y = Math.sin(t * 1.6) * 0.1
      body.rotation.z = Math.sin(t * 0.8) * 0.03
      head.rotation.y = Math.sin(t * 0.45) * 0.24
      head.rotation.z = 0.06 + Math.sin(t * 0.7 + 1) * 0.05
      armL.rotation.x = Math.sin(t * 1.6 + 1) * 0.12
      armR.rotation.x = -Math.sin(t * 1.6 + 1) * 0.12
      // 周期性眨眼（双眼组整体 y 压扁再回弹）
      const blink = Math.abs(Math.sin(t * 0.9)) > 0.965 ? 0.12 : 1
      eyes.scale.y += (blink - eyes.scale.y) * 0.3
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
