import { ArrowLeft, Eye, Network } from '@phosphor-icons/react'

export function P2PConsentView({ publicIpNotice, onAccept, onCancel }: {
  publicIpNotice: string
  onAccept: () => Promise<void> | void
  onCancel: () => void
}) {
  return (
    <>
      <h1>确认公开公网 IP</h1>
      <p>这个房间当前使用 P2P 直连。进入后，你的公网地址会直接显示在用户名后面。</p>
      <div className="privacy-callout p2p-consent"><Eye /><span>{publicIpNotice} 即使稍后切换到 TURN，也无法撤回其他成员已经看到的地址。</span></div>
      <div className="consent-actions">
        <button className="top-action" type="button" onClick={onCancel}><ArrowLeft />取消</button>
        <button className="primary-button" type="button" onClick={() => void onAccept()}><Network />同意并加入</button>
      </div>
    </>
  )
}
