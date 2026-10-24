import {
  Drawer as AntDrawer,
  Modal as AntModal,
  type DrawerProps,
  type ModalProps,
} from "antd";
export const overlayContainer = (): HTMLElement =>
  document.getElementById("admin-overlays") ?? document.body;
/** Scoped portal placement; all behavior remains Ant Design's implementation. */
export function Drawer(props: DrawerProps): JSX.Element {
  return <AntDrawer getContainer={overlayContainer} {...props} />;
}
export function Modal(props: ModalProps): JSX.Element {
  return <AntModal getContainer={overlayContainer} {...props} />;
}
