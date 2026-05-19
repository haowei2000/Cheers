import { Link } from "react-router-dom";
import { AppIcon } from "../../../components/icons";
import { API_DOCS_URL, USER_DOCS_URL } from "../../../lib/app-config";

export function DocsPane() {
  return (
    <div className="an-pane">
      <div className="an-pane-head">
        <div>
          <div className="an-pane-title">Docs</div>
          <div className="an-pane-sub">User guides, operations manuals, and API reference.</div>
        </div>
      </div>
      <div className="an-list-table">
        <Link
          to={USER_DOCS_URL}
          className="an-row-card"
          style={{ justifyContent: "space-between", textDecoration: "none" }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="an-rc-title">User Docs</div>
            <div className="an-rc-sub">User guides and operations manuals</div>
          </div>
          <AppIcon name="chevronRight" className="an-rc-chev" />
        </Link>
        <a
          href={API_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="an-row-card"
          style={{ justifyContent: "space-between", textDecoration: "none" }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="an-rc-title">API Docs</div>
            <div className="an-rc-sub">Backend API reference</div>
          </div>
          <AppIcon name="externalLink" className="an-rc-chev" />
        </a>
      </div>
    </div>
  );
}
