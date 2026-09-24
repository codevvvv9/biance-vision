import { useAi } from './AiContext'
import AiChat from './AiChat'
import AiRobot from './AiRobot'

/** AI 助手组合壳：3D 机器人 + 聊天窗（仅在超管完成 AI 配置后出现） */
export default function AiAssistant(): JSX.Element | null {
  const { robotVisible, chatOpen, setChatOpen, hideRobot } = useAi()
  if (!robotVisible) return null
  return (
    <>
      <AiRobot onOpen={() => setChatOpen(!chatOpen)} onHide={hideRobot} hidden={chatOpen} />
      {chatOpen && <AiChat onClose={() => setChatOpen(false)} />}
    </>
  )
}
