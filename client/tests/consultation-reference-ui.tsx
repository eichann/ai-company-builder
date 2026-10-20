import { OpenConsultationContext } from '../src/components/chat/consultation-context'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConsultationReferenceLink } from '../src/components/chat/ConsultationReference'
import '../src/index.css'
function Preview() {
  const [opened, setOpened] = useState(false)
  return <OpenConsultationContext.Provider value={() => setOpened(true)}><main className="min-h-screen bg-white text-gray-900 p-8"><p className="text-xs text-gray-500 mb-8">表示確認用の人工データ。本番の相談には接続しません。</p><section className="max-w-xl mx-auto border rounded-xl p-6"><h1 className="text-lg font-semibold mb-6">桜計画の提案書</h1><p className="text-sm leading-7">別の相談で決めた料金を確認しました。訂正後の月額12,347円で提案書を作成します。</p><ConsultationReferenceLink reference={{ id:'source', title:'桜計画の料金・契約条件' }}/>{opened && <aside className="mt-6 p-4 bg-gray-50 rounded-lg text-sm"><h2 className="font-semibold mb-3">桜計画の料金・契約条件</h2><p>料金は月額12,347円に訂正します。</p><button onClick={() => setOpened(false)} className="mt-4 text-xs text-gray-500">閉じる</button></aside>}</section></main></OpenConsultationContext.Provider>
}
createRoot(document.getElementById('root')!).render(<Preview />)
