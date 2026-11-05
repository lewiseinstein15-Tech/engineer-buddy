# Buddy Desktop - Start Menu shortcut (Windows): Buddy appears in the Start
# menu with its own icon and launches desktop\buddy-desktop.cmd (server
# booted if needed, UI in its own chromeless app window).
$desktop = Split-Path -Parent $MyInvocation.MyCommand.Path
$sm = [Environment]::GetFolderPath('Programs')
$s = (New-Object -ComObject WScript.Shell).CreateShortcut("$sm\Buddy Desktop.lnk")
$s.TargetPath = Join-Path $desktop 'buddy-desktop.cmd'
$s.WorkingDirectory = $desktop
$s.IconLocation = Join-Path $desktop 'app-icons\buddy.ico'
$s.Description = 'engineer-buddy - the keyless AI engineering agent'
$s.Save()
Write-Host "installed: $sm\Buddy Desktop.lnk"
