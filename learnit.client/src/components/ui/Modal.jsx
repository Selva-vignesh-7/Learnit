import clsx from "clsx";
import { useEffect } from "react";
import styles from "./ui.module.css";

function Modal({ title, kicker, onClose, children, className, actions }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <div
      className={styles.modalOverlay}
      role="dialog"
      aria-modal="true"
      aria-label={title || "Modal dialog"}
    >
      <div className={clsx(styles.modalPanel, className)}>
        <header className={styles.modalHeader}>
          <div>
            {kicker && <p className={styles.modalKicker}>{kicker}</p>}
            {title && <h2>{title}</h2>}
          </div>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close dialog"
          >
            ×
          </button>
        </header>
        <div className={styles.modalBody}>{children}</div>
        {actions && <div className={styles.modalActions}>{actions}</div>}
      </div>
    </div>
  );
}

export default Modal;
