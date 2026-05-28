const fs = require('fs')
const file =
	'f:/Devs/Stumpnew/stump/packages/browser/src/components/readers/pdf/NativePDFViewer.tsx'
let content = fs.readFileSync(file, 'utf8')

const buttonsBlockRegex =
	/\{isPaged && !isMobile && \(\s*<>\s*<button[\s\S]+?<\/button>\s*<button[\s\S]+?<\/button>\s*<\/>\s*\)\}/
content = content.replace(
	buttonsBlockRegex,
	`{isPaged && !isMobile && (
                                <>
                                        <div
                                                className="left-0 w-[10%] cursor-pointer absolute inset-y-0 z-50 bg-transparent"
                                                onClick={(event) => {
                                                        event.stopPropagation()
                                                        if (canGoBack) onPageChange?.(Math.max(1, page - 1))
                                                }}
                                        />
                                        <div
                                                className="right-0 w-[10%] cursor-pointer absolute inset-y-0 z-50 bg-transparent"
                                                onClick={(event) => {
                                                        event.stopPropagation()
                                                        if (canGoForward) onPageChange?.(Math.min(totalPages, page + 1))
                                                }}
                                        />
                                        <div
                                                className="left-[10%] right-[10%] cursor-pointer absolute inset-y-0 z-40 bg-transparent"
                                                onClick={(event) => {
                                                        event.stopPropagation()
                                                        setShowOverlay(!showOverlay)
                                                }}
                                        />
                                </>
                        )}`,
)

const hoverBlockRegex =
	/\{\!showOverlay && !isMobile && isPaged && \(\s*<>\s*<div\s*className="inset-x-0 top-0 h-8 absolute z-40 bg-transparent"\s*onMouseEnter=\{\(\) => setShowOverlay\(true\)\}\s*\/>\s*<div className="right-3 top-3 absolute z-30">\s*<Button size="xs" variant="ghost" onClick=\{\(\) => setShowOverlay\(true\)\}>\s*Show controls\s*<\/Button>\s*<\/div>\s*<\/>\s*\)\}/
content = content.replace(hoverBlockRegex, '')

fs.writeFileSync(file, content)
