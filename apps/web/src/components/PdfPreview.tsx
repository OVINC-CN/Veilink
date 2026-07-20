import { useEffect, useRef, useState } from 'react'
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

export function PdfPreview({ url, name }: { url: string; name: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const task = getDocument({
      url,
      disableRange: true,
      disableAutoFetch: true,
      disableStream: true,
      useWorkerFetch: false,
      useWasm: false,
      enableXfa: false,
      stopAtErrors: true,
      maxImageSize: 16_000_000,
    })
    void (async () => {
      try {
        const pdf = await task.promise
        const page = await pdf.getPage(1)
        if (cancelled || !canvas.current) return
        const base = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: Math.min(1.5, 240 / base.width) })
        const context = canvas.current.getContext('2d', { alpha: false })
        if (!context) throw new Error('Canvas is unavailable')
        canvas.current.width = Math.ceil(viewport.width)
        canvas.current.height = Math.ceil(viewport.height)
        await page.render({ canvas: canvas.current, canvasContext: context, viewport }).promise
        await pdf.destroy()
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [url])

  if (failed) return null
  return <canvas className="pdf-preview" ref={canvas} aria-label={`${name} 第一页预览`} />
}
