# FlowChain interface language

- English (`en-US`) is the default user interface language. Keep Chinese (`zh-CN`)
  available through the language settings.
- Write new user-facing UI copy in English and supply a Chinese translation using
  the existing i18n context. Avoid new unconditional Chinese UI strings.
- Language changes must not change business identifiers, stored business values,
  currencies, number/date locales, timezones, or authorization behavior.
- See `docs/interface-language-policy.md` for rollout details and remaining
  localization gaps. Do not claim full bilingual coverage until the relevant
  pages and server-generated content have been checked in both languages.
