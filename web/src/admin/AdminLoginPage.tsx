import { Alert, Button, Card, Form, Input, Typography } from "antd";
import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { useState } from "react";
import { apiErrorMessage, useAuth } from "@biance/shared-ui";
import { useTranslation } from "react-i18next";
import { Brand } from "./ui/Brand";
import { Language } from "./ui/Language";
import { useAdminText } from "./ui/text";
import styles from "./ui/admin.module.css";
export default function AdminLoginPage({
  notice,
  onAuthenticated,
}: {
  notice?: string;
  onAuthenticated?: () => void;
}): JSX.Element {
  const { login } = useAuth();
  const { t } = useTranslation("admin");
  const text = useAdminText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async ({
    username,
    password,
  }: {
    username: string;
    password: string;
  }) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await login(username.trim(), password);
      onAuthenticated?.();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className={styles.login}>
      <div className={styles.loginLanguage}>
        <Language />
      </div>
      <Card className={styles.loginCard}>
        <Brand />
        <Typography.Title level={3}>{text("loginTitle")}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {text("adminOnly")}
        </Typography.Paragraph>
        {notice && <Alert type="warning" title={notice} showIcon />}
        {error && <Alert type="error" title={error} role="alert" showIcon />}
        <Form layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item
            name="username"
            label={t("gate.user")}
            rules={[
              { required: true, whitespace: true, message: t("gate.required") },
            ]}
          >
            <Input
              prefix={<UserOutlined />}
              autoComplete="username"
              autoFocus
            />
          </Form.Item>
          <Form.Item
            name="password"
            label={t("gate.password")}
            rules={[{ required: true, message: t("gate.required") }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              autoComplete="current-password"
            />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            aria-label={t("gate.submit")}
            aria-busy={busy}
            disabled={busy}
            loading={busy}
            block
          >
            {t("gate.submit")}
          </Button>
        </Form>
        <Typography.Paragraph className={styles.loginFoot} type="secondary">
          {text("loginFoot")}
        </Typography.Paragraph>
      </Card>
    </main>
  );
}
