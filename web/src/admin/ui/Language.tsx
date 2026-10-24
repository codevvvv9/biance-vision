import { Select } from "antd";
import { useTranslation } from "react-i18next";
export function Language(): JSX.Element {
  const { t, i18n } = useTranslation("admin");
  return (
    <Select
      aria-label={t("ui.language")}
      value={i18n.language.startsWith("zh") ? "zh-CN" : "en-US"}
      onChange={(value) => void i18n.changeLanguage(value)}
      options={[
        { value: "zh-CN", label: t("ui.languageZh") },
        { value: "en-US", label: t("ui.languageEn") },
      ]}
    />
  );
}
