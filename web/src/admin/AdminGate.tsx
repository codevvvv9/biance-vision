import { Button, Result } from "antd";
import { useAuth } from "@biance/shared-ui";
import { Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import AdminLoginPage from "./AdminLoginPage";
import { Loading } from "./ui/feedback";
import { createContext, useContext, useState, type ReactNode } from "react";
const Notice = createContext<{
  notice: string;
  setNotice: (value: string) => void;
}>({ notice: "", setNotice: () => {} });
export function AdminSessionNotice({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [notice, setNotice] = useState("");
  return (
    <Notice.Provider value={{ notice, setNotice }}>{children}</Notice.Provider>
  );
}
export function useSessionNotice() {
  return useContext(Notice);
}
export default function AdminGate(): JSX.Element {
  const { user, loading, logout } = useAuth();
  const { t } = useTranslation("admin");
  const { notice, setNotice } = useSessionNotice();
  if (loading) return <Loading />;
  if (!user)
    return (
      <AdminLoginPage notice={notice} onAuthenticated={() => setNotice("")} />
    );
  if (user.role !== "superadmin")
    return (
      <Result
        status="403"
        title={t("gate.forbidden")}
        subTitle={t("gate.forbiddenHint", { user: user.username })}
        extra={
          <Button onClick={() => void logout()}>{t("gate.logout")}</Button>
        }
      />
    );
  return <Outlet key={user.username} />;
}
