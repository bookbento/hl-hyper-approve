/**
 * One-click email action result pages.
 * Copied byte-for-byte from backend/views/email-actions/*.html (Express served
 * them from disk); placeholders __VIEW_LINK__, __CONDITION_SECTION__, __REASON_SECTION__.
 */
export const EMAIL_ACTION_PAGES = {
  approved:
    '<!DOCTYPE html>\n<html lang="th">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>Document has been approved</title>\n    <style>\n      body {\n        margin: 0;\n        padding: 0 1rem;\n        display: flex;\n        flex-direction: column;\n        align-items: center;\n        justify-content: center;\n        min-height: 100vh;\n        font-family: sans-serif;\n        background-color: #f0fdf4;\n        text-align: center;\n      }\n      img {\n        width: 80%;\n        max-width: 300px;\n        height: auto;\n        margin-bottom: 1rem;\n      }\n      h1 {\n        font-size: 1.5rem;\n        color: #0c7f36;\n        margin: 0.5rem 0;\n      }\n      p {\n        margin-top: 1rem;\n      }\n      a {\n        display: inline-block;\n        padding: 0.5rem 1rem;\n        color: #fff;\n        background-color: #0c7f36;\n        border-radius: 4px;\n        text-decoration: none;\n        font-weight: bold;\n      }\n      @media (max-width: 480px) {\n        h1 {\n          font-size: 1.2rem;\n        }\n        a {\n          padding: 0.4rem 0.8rem;\n          font-size: 0.9rem;\n        }\n      }\n    </style>\n  </head>\n  <body>\n    <h1>✅ Document has been approved</h1>\n    __CONDITION_SECTION__\n    <p>\n      <a href="__VIEW_LINK__">Return to HyLife e-Approval</a>\n    </p>\n  </body>\n</html>\n',
  rejected:
    '<!DOCTYPE html>\n<html lang="th">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>Document has been rejected</title>\n    <style>\n      body {\n        margin: 0;\n        padding: 0 1rem;             /* ให้มี padding ซ้าย-ขวาเล็กน้อย */\n        display: flex;\n        flex-direction: column;\n        align-items: center;\n        justify-content: center;\n        min-height: 100vh;           /* ใช้ min-height แทน height */\n        font-family: sans-serif;\n        background-color: #fef3f2;\n        text-align: center;\n      }\n      img {\n        width: 80%;                  /* ยืดหยุ่นตามหน้าจอ */\n        max-width: 300px;\n        height: auto;\n        margin-bottom: 1rem;\n      }\n      h1 {\n        font-size: 1.5rem;\n        color: #bf1e2e;\n        margin: 0.5rem 0;\n      }\n      p {\n        margin-top: 1rem;\n      }\n      a {\n        display: inline-block;       /* ให้พื้นที่คลิกใหญ่ขึ้น */\n        padding: 0.5rem 1rem;\n        color: #fff;\n        background-color: #bf1e2e;\n        border-radius: 4px;\n        text-decoration: none;\n        font-weight: bold;\n      }\n      /* ปรับขนาดตัวหนังสือบนมือถือ */\n      @media (max-width: 480px) {\n        h1 {\n          font-size: 1.2rem;\n        }\n        a {\n          padding: 0.4rem 0.8rem;\n          font-size: 0.9rem;\n        }\n      }\n    </style>\n  </head>\n  <body>\n    <h1>❌ Document has been rejected</h1>\n    __REASON_SECTION__\n    <p>\n      <a href="__VIEW_LINK__">Return to HyLife e-Approval</a>\n    </p>\n  </body>\n</html>\n',
  terminated:
    '<!DOCTYPE html>\n<html lang="th">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>Document has been terminated</title>\n    <style>\n      body {\n        margin: 0;\n        padding: 0 1rem;\n        display: flex;\n        flex-direction: column;\n        align-items: center;\n        justify-content: center;\n        min-height: 100vh;\n        font-family: sans-serif;\n        background: #f2dd7e;  \n        text-align: center;\n      }\n      img {\n        width: 80%;\n        max-width: 300px;\n        height: auto;\n        margin-bottom: 1rem;\n      }\n      h1 {\n        font-size: 1.5rem;\n        color: #423a09;                     /* แดงเข้ม */\n        margin: 0.5rem 0;\n      }\n      p {\n        margin-top: 1rem;\n      }\n      a {\n        display: inline-block;\n        padding: 0.5rem 1rem;\n        color: #fff;\n        background-color: #cfb200;\n        border-radius: 4px;\n        text-decoration: none;\n        font-weight: bold;\n      }\n      @media (max-width: 480px) {\n        h1 { font-size: 1.2rem; }\n        a  { padding: 0.4rem 0.8rem; font-size: 0.9rem; }\n      }\n    </style>\n  </head>\n  <body>\n    <h1>🛑 Memo has been terminated</h1>\n    __REASON_SECTION__\n    <p>\n      <a href="__VIEW_LINK__">Return to HyLife e-Approval</a>\n    </p>\n  </body>\n</html>\n',
} as const;

export type UsedView = { title: string; verb: string; bg: string; accent: string };

/** Link already used: shows what the approver did, plus any condition/reason. (inline in Express) */
export const usedPage = (v: UsedView, extraSection: string) => `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${v.title}</title>
    <style>
      body { margin:0; padding:0 1rem; display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; font-family:sans-serif; background:${v.bg}; text-align:center; }
      img { width:100%; max-width:200px; height:auto; margin-bottom:1rem; }
      h1 { font-size:1.5rem; color:${v.accent}; margin-bottom:0.5rem; }
      p  { font-size:1rem; color:#333; }
      a  { display:inline-block; margin-top:1rem; padding:0.5rem 1rem; background:${v.accent}; color:#fff; text-decoration:none; border-radius:4px; font-weight:bold; }
      @media (max-width:480px){ h1{font-size:1.2rem} p{font-size:.9rem} a{padding:.4rem .8rem; font-size:.9rem} }
    </style>
  </head>
  <body>

    <h1>${v.title}</h1>
    <p>You have already ${v.verb} this Document.</p>
    ${extraSection}
    <a href="__VIEW_LINK__">Return to HyLife e-Approval</a>
  </body>
</html>
`;

/** Token does not match the row any more (a newer email was sent). (inline in Express) */
export const canceledPage = () => `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Link Canceled or Used</title>
        <style>
          body {
            margin: 0;
            padding: 0 1rem;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            font-family: sans-serif;
            background-color: #c8c9c5;
            text-align: center;
          }
          img {
            width: 80%;
            max-width: 250px;
            height: auto;
            margin-bottom: 1rem;
          }
          h1 {
            font-size: 1.5rem;
            color: #000000;
            margin-bottom: 0.5rem;
          }
          p {
            font-size: 1rem;
            color: #333;
          }
          a {
            display: inline-block;
            margin-top: 1rem;
            padding: 0.5rem 1rem;
            background-color: #201e21;
            color: #fff;
            text-decoration: none;
            border-radius: 4px;
            font-weight: bold;
          }
          @media (max-width: 480px) {
            h1 { font-size: 1.2rem; }
            p  { font-size: 0.9rem; }
            a  { padding: 0.4rem 0.8rem; font-size: 0.9rem; }
          }
        </style>
      </head>
      <body>

        <h1>This link has been canceled or already used</h1>
        <p>Please request a new approval email.</p>
        <a href="__VIEW_LINK__">Return to HyLife e-Approval</a>
      </body>
    </html>
  `;

/** Memo passed its expiresAt. (inline in Express) */
export const expiredPage = (actionText: string) => `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Document Expired</title>
        <style>
          body {
            margin: 0;
            padding: 0 1rem;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            font-family: sans-serif;
            background-color: #fdecfdff;
            text-align: center;
          }
          img {
            width: 100%;
            max-width: 300px;
            height: auto;
            margin-bottom: 1rem;
          }
          h1 {
            font-size: 1.5rem;
            color: #831562ff;
            margin-bottom: 0.5rem;
          }
          p {
            font-size: 1rem;
            color: #333;
          }
          a {
            display: inline-block;
            margin-top: 1rem;
            padding: 0.5rem 1rem;
            background-color: #da2cd4ff;
            color: #fff;
            text-decoration: none;
            border-radius: 4px;
            font-weight: bold;
          }
          @media (max-width: 480px) {
            h1 { font-size: 1.2rem; }
            p  { font-size: 0.9rem; }
            a  { padding: 0.4rem 0.8rem; font-size: 0.9rem; }
          }
        </style>
      </head>
      <body>

        <h1>This Document Has Expired</h1>
        <p>You cannot ${actionText} this document because it has already expired.</p>
        <a href="__VIEW_LINK__">Return to HyLife e-Approval</a>
      </body>
    </html>
  `;

/** Memo is no longer Processing. (inline in Express) */
export const notProcessingPage = (actionText: string) => `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Cannot ${actionText}</title>
        <style>
          body {
            margin: 0;
            padding: 0 1rem;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            font-family: sans-serif;
            background-color: #fff5f5;
            text-align: center;
          }
          img {
            width: 80%;
            max-width: 200px;
            height: auto;
            margin-bottom: 1rem;
          }
          h1 {
            font-size: 1.5rem;
            color: #c42b2b;
            margin-bottom: 0.5rem;
          }
          p {
            font-size: 1rem;
            color: #333;
          }
          a {
            display: inline-block;
            margin-top: 1rem;
            padding: 0.5rem 1rem;
            background-color: #c42b2b;
            color: #fff;
            text-decoration: none;
            border-radius: 4px;
            font-weight: bold;
          }
          @media (max-width: 480px) {
            h1 { font-size: 1.2rem; }
            p  { font-size: 0.9rem; }
            a  { padding: 0.4rem 0.8rem; font-size: 0.9rem; }
          }
        </style>
      </head>
      <body>

        <h1>Cannot ${actionText}</h1>
        <p>The document is not in the Processing stage.</p>
        <a href="__VIEW_LINK__">Return to HyLife e-Approval</a>
      </body>
    </html>
  `;
