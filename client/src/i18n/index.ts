import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import ja from './locales/ja.json'

// Get initial language from localStorage or browser settings
const getInitialLanguage = (): string => {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('language')
    if (saved === 'en' || saved === 'ja') {
      return saved
    }
    // Check browser language
    const browserLang = navigator.language.split('-')[0]
    if (browserLang === 'ja') {
      return 'ja'
    }
  }
  return 'ja' // Default to Japanese
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ja: { translation: ja },
    },
    lng: getInitialLanguage(),
    fallbackLng: 'ja',
    interpolation: {
      escapeValue: false, // React already does escaping
    },
  })

export default i18n
