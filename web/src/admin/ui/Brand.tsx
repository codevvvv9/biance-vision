import { Typography } from "antd";
import icon from "../../../../packages/brand/mark.svg";
import { useTranslation } from "react-i18next";
import styles from "./admin.module.css";
/** Canonical W4 brand asset shared with the public website. */
export function Brand({ compact = false }: { compact?: boolean }): JSX.Element {
  const { t } = useTranslation("admin");
  return (
    <div className={styles.brand}>
      {icon && <img src={icon} width={30} height={30} alt="" />}
      {!compact && (
        <div>
          <strong>BIANCE VISION</strong>
          <Typography.Text type="secondary">
            {t("layout.title")}
          </Typography.Text>
        </div>
      )}
    </div>
  );
}
