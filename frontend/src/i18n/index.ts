// src/i18n/index.ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import Backend from "i18next-http-backend";          

i18n
  .use(Backend)                                      
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: "en",
    ns: ["nav", "profile","memoForm", "dashboard", "memoViewer", "memoTypeManager", "memoTypeDisplay", "memoTypeDetail", "notifications", "users", "createTeam", "createDepartment", "createBusinessUnit","showApprover", "common"],
    defaultNS: "nav",
    debug: false,
    interpolation: { escapeValue: false },
    backend: {
      loadPath: "/locales/{{lng}}/{{ns}}.json"     
    }
  });

export default i18n;
