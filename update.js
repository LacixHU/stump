const fs = require('fs')
const file =
	'f:/Devs/Stumpnew/stump/packages/browser/src/components/readers/pdf/NativePDFViewer.tsx'
let content = fs.readFileSync(file, 'utf8')

const startDiv = '<div className="inset-0 absolute flex flex-col overflow-hidden bg-background">'
content = content.replace(
	startDiv,
	`<ImageBaseReaderContext.Provider
                        value={{
                                book: book,
                                currentPage: page,
                                getPageUrl: p => sdk.media.bookPageURL(id, p),
                                imageSizes: {},
                                pageSets: [],
                                setCurrentPage: p => onPageChange?.(p),
                                setPageSize: () => {},
                                timer: { getCurrentTime: () => 0, start: () => {}, stop: () => {}, reset: () => {} },
                                toggleToolbar: () => setShowOverlay(prev => !prev),
                        }}
                >\n` + startDiv,
)

const endDiv = '</div>\n\t)'
content = content.replace(endDiv, '</div>\n\t\t</ImageBaseReaderContext.Provider>\n\t)')

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

const zoomOutBtn = '<Button size="xs" variant="ghost" onClick={zoomOut} disabled={zoom <= 1}>'
content = content.replace(
	zoomOutBtn,
	'<SettingsDialog />\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t' + zoomOutBtn,
)

fs.writeFileSync(file, content)
