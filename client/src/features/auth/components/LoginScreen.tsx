import { ArrowSquareOut } from '@phosphor-icons/react'
import { useAuthStore } from '../../../stores/authStore'
import { SignInForm } from './SignInForm'

/** Sign-in on the server this computer is set to (`serverUrl`): its host shows above the form (SignInForm). */
export function LoginScreen({ serverUrl }: { serverUrl: string }) {
  const { signIn, isLoading } = useAuthStore()

  return (
    <div className="h-full bg-[var(--color-surface)] flex flex-col items-center justify-center">
      <SignInForm
        server={serverUrl}
        title="ログイン"
        note="招待されたメールアドレスでログインします"
        busy={isLoading}
        onSignIn={async (email, password) => {
          const result = await signIn(email, password, serverUrl)
          return result.success ? null : (result.error || 'ログインできませんでした')
        }}
      />
      <div className="w-full max-w-md px-8 pb-8">
        <div className="pt-4 border-t border-[color:var(--color-border)] text-center">
          <a
            href={serverUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-body text-link hover:underline"
          >
            アカウントをお持ちでない方（Webサイトで新規登録）
            <ArrowSquareOut size={14} />
          </a>
        </div>
      </div>
    </div>
  )
}
